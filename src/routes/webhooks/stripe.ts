import { Router, Request, Response } from 'express';
import Stripe from 'stripe';
import { getStripe, getPlanFromPriceId, getBillingCycleFromInterval } from '../../lib/stripe';
import { connect } from '../../db';
import { invalidateTierCache } from '../../lib/tierResolver';
import logger from '../../utils/logger';

const router = Router();

router.post('/stripe', async (req: Request, res: Response) => {
  const stripe = getStripe();
  if (!stripe) {
    logger.warn('Stripe webhook received but Stripe not configured');
    return res.status(200).json({ received: true });
  }

  const sig = req.headers['stripe-signature'] as string;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!webhookSecret) {
    logger.warn('Stripe webhook secret not configured');
    return res.status(200).json({ received: true });
  }

  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err: any) {
    logger.error('Stripe webhook signature verification failed', { error: err.message });
    return res.status(400).json({ error: `Webhook Error: ${err.message}` });
  }

  logger.info('Stripe webhook received', { type: event.type, id: event.id });

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        await handleCheckoutCompleted(stripe, session);
        break;
      }

      case 'customer.subscription.updated': {
        const subscription = event.data.object as Stripe.Subscription;
        await handleSubscriptionUpdated(stripe, subscription);
        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object as Stripe.Subscription;
        await handleSubscriptionDeleted(subscription);
        break;
      }

      case 'invoice.paid': {
        const invoice = event.data.object as Stripe.Invoice;
        logger.info('Invoice paid', {
          invoiceId: invoice.id,
          customerId: invoice.customer,
          amount: invoice.amount_paid,
        });
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object as Stripe.Invoice;
        logger.warn('Invoice payment failed', {
          invoiceId: invoice.id,
          customerId: invoice.customer,
          amount: invoice.amount_due,
        });
        break;
      }

      default:
        logger.debug('Unhandled Stripe webhook event', { type: event.type });
    }
  } catch (error: any) {
    logger.error('Stripe webhook processing error', { type: event.type, error: error.message });
  }

  res.status(200).json({ received: true });
});

async function handleCheckoutCompleted(stripe: Stripe, session: Stripe.Checkout.Session) {
  const orgId = session.metadata?.orgId;
  const plan = session.metadata?.plan;
  const billingCycle = session.metadata?.billingCycle;

  if (!orgId || !plan) {
    logger.warn('Checkout session missing metadata', { sessionId: session.id });
    return;
  }

  const db = await connect();
  if (!db) {
    logger.error('Database unavailable during checkout webhook');
    return;
  }

  const customerId = typeof session.customer === 'string'
    ? session.customer
    : (session.customer as any)?.id;

  const subscriptionId = typeof session.subscription === 'string'
    ? session.subscription
    : (session.subscription as any)?.id;

  await db.collection('organizations').updateOne(
    { id: orgId },
    {
      $set: {
        tier: plan,
        billing_cycle: billingCycle || 'monthly',
        stripe_customer_id: customerId || null,
        stripe_subscription_id: subscriptionId || null,
        plan_updated_at: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    }
  );

  // Invalidate cached tier so rate limiters pick up new limits immediately
  invalidateTierCache(orgId);

  logger.info('Organization upgraded via checkout', {
    orgId,
    plan,
    billingCycle,
    customerId,
    subscriptionId,
  });
}

async function handleSubscriptionUpdated(stripe: Stripe, subscription: Stripe.Subscription) {
  const customerId = typeof subscription.customer === 'string'
    ? subscription.customer
    : (subscription.customer as any)?.id;

  if (!customerId) return;

  const db = await connect();
  if (!db) return;

  const org = await db.collection('organizations').findOne({ stripe_customer_id: customerId });
  if (!org) {
    logger.warn('No org found for Stripe customer', { customerId });
    return;
  }

  const priceId = subscription.items.data[0]?.price?.id;
  if (!priceId) return;

  const newPlan = getPlanFromPriceId(priceId);
  const interval = subscription.items.data[0]?.price?.recurring?.interval;
  const newCycle = getBillingCycleFromInterval(interval);

  if (newPlan && newPlan !== org.tier) {
    await db.collection('organizations').updateOne(
      { id: org.id },
      {
        $set: {
          tier: newPlan,
          billing_cycle: newCycle,
          stripe_subscription_id: subscription.id,
          plan_updated_at: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      }
    );

    // Invalidate cached tier so rate limiters pick up new limits immediately
    invalidateTierCache(org.id);

    logger.info('Subscription updated', {
      orgId: org.id,
      oldTier: org.tier,
      newTier: newPlan,
      cycle: newCycle,
    });
  }
}

async function handleSubscriptionDeleted(subscription: Stripe.Subscription) {
  const customerId = typeof subscription.customer === 'string'
    ? subscription.customer
    : (subscription.customer as any)?.id;

  if (!customerId) return;

  const db = await connect();
  if (!db) return;

  const result = await db.collection('organizations').updateOne(
    { stripe_customer_id: customerId },
    {
      $set: {
        tier: 'free',
        billing_cycle: 'monthly',
        stripe_subscription_id: null,
        plan_updated_at: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    }
  );

  if (result.modifiedCount > 0) {
    // Find the org to invalidate its tier cache
    const org = await db.collection('organizations').findOne({ stripe_customer_id: customerId });
    if (org) invalidateTierCache(org.id);

    logger.info('Subscription deleted, org downgraded to free', { customerId });
  }
}

export default router;
