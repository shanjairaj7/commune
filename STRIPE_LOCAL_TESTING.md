# Stripe Local Testing Setup Guide

## Quick Start

Follow these steps to test the Stripe payment flow locally:

### Step 1: Get Stripe Test API Keys

1. Open Stripe dashboard in test mode: https://dashboard.stripe.com/test/apikeys
2. Copy your **Secret key** (starts with `sk_test_...`)
3. Paste it into `backend/.env.local` replacing `STRIPE_SECRET_KEY=sk_test_YOUR_TEST_KEY_HERE`

### Step 2: Create Test Products & Prices

1. Go to: https://dashboard.stripe.com/test/products
2. Click **"+ Add product"**
3. Create these products:

#### Agent Pro - Monthly
- Name: `Agent Pro Monthly`
- Price: `$19.00 USD`
- Billing period: `Monthly`
- Copy the **Price ID** (starts with `price_...`)
- Paste into `.env.local` as `STRIPE_PRICE_AGENT_PRO_MONTHLY`

#### Agent Pro - Yearly
- Name: `Agent Pro Yearly`
- Price: `$192.00 USD` (16/mo × 12)
- Billing period: `Yearly`
- Copy the **Price ID**
- Paste into `.env.local` as `STRIPE_PRICE_AGENT_PRO_YEARLY`

#### Business - Monthly
- Name: `Business Monthly`
- Price: `$49.00 USD`
- Billing period: `Monthly`
- Copy the **Price ID**
- Paste into `.env.local` as `STRIPE_PRICE_BUSINESS_MONTHLY`

#### Business - Yearly
- Name: `Business Yearly`
- Price: `$492.00 USD` (41/mo × 12)
- Billing period: `Yearly`
- Copy the **Price ID**
- Paste into `.env.local` as `STRIPE_PRICE_BUSINESS_YEARLY`

### Step 3: Start Stripe Webhook Forwarding

Open a **new terminal** and run:

```bash
cd backend
./setup-stripe-local.sh
```

This will:
- Start Stripe CLI webhook forwarding
- Forward webhooks from Stripe to `http://localhost:8000/api/webhooks/stripe`
- Display a webhook signing secret (starts with `whsec_...`)

**Copy the webhook secret** and paste it into `.env.local`:
```bash
STRIPE_WEBHOOK_SECRET=whsec_xxxxxxxxxxxxx
```

**Keep this terminal open** while testing!

### Step 4: Start Backend Server

Open another terminal:

```bash
cd backend
npm run dev
```

Backend will start on `http://localhost:8000`

### Step 5: Start Frontend Dashboard

Open another terminal:

```bash
cd frontend
npm run dev
```

Frontend will start on `http://localhost:3001`

### Step 6: Test Payment Flow

#### Test 1: Dashboard Checkout

1. Go to: http://localhost:3001
2. Login with your test account
3. Navigate to **Billing** page
4. Click **"upgrade"** on Agent Pro plan
5. Use Stripe test card: `4242 4242 4242 4242`
   - Expiry: Any future date (e.g., `12/34`)
   - CVC: Any 3 digits (e.g., `123`)
   - ZIP: Any 5 digits (e.g., `12345`)
6. Complete payment
7. You should be redirected back with `?payment=success`
8. After 2 seconds, plan should update to "Agent Pro"

**Check backend terminal** for:
```
✅ Stripe webhook received
✅ Organization upgraded via checkout
```

#### Test 2: Website Checkout (if website running locally)

1. Make sure you're logged in to the dashboard first
2. Go to website pricing page
3. Click upgrade button
4. Should redirect to Stripe checkout
5. Complete payment with test card
6. Return to dashboard
7. Verify plan updated

### Step 7: Test Subscription Management

1. On billing page, click **"manage billing"**
2. Should redirect to Stripe billing portal
3. Try changing plan (upgrade/downgrade)
4. Try canceling subscription
5. Verify webhooks process correctly in backend logs

## Test Cards

Stripe provides test cards for different scenarios:

- **Success**: `4242 4242 4242 4242`
- **Decline**: `4000 0000 0000 0002`
- **3D Secure**: `4000 0027 6000 3184`
- **Insufficient funds**: `4000 0000 0000 9995`

More test cards: https://stripe.com/docs/testing

## Webhook Events to Monitor

Watch backend logs for these events:

### Successful Payment Flow
```
[INFO] Stripe webhook received { type: 'checkout.session.completed' }
[INFO] Organization upgraded via checkout { orgId: '...', plan: 'agent_pro' }
```

### Subscription Update
```
[INFO] Stripe webhook received { type: 'customer.subscription.updated' }
[INFO] Subscription updated { orgId: '...', oldTier: 'agent_pro', newTier: 'business' }
```

### Subscription Cancellation
```
[INFO] Stripe webhook received { type: 'customer.subscription.deleted' }
[INFO] Subscription deleted, org downgraded to free
```

### ❌ Errors to Watch For

```
[WARN] Checkout session missing metadata — CRITICAL BUG (should never happen after fix)
[ERROR] Database unavailable during checkout webhook — Infrastructure issue
[WARN] No org found for Stripe customer — Data inconsistency
```

## Troubleshooting

### Webhook not receiving events

**Check**:
1. Is `stripe listen` still running?
2. Is backend server running on port 8000?
3. Check backend logs for webhook signature errors

**Fix**: Restart `stripe listen` and update `STRIPE_WEBHOOK_SECRET` in `.env.local`

### Payment succeeds but plan doesn't update

**Check**:
1. Backend logs for: `"Checkout session missing metadata"`
2. Check if `orgId` is in Stripe session metadata

**Fix**: This was the bug we fixed. Make sure you're using the updated code.

### Frontend shows old plan after payment

**Check**:
1. Wait 2-3 seconds for auto-refetch
2. Check browser console for API errors

**Fix**: Manually refresh the page. The auto-refetch should work after our fix.

## Environment Variables Checklist

Make sure these are set in `backend/.env.local`:

- [x] `STRIPE_SECRET_KEY` (starts with `sk_test_`)
- [x] `STRIPE_WEBHOOK_SECRET` (starts with `whsec_`)
- [x] `STRIPE_PRICE_AGENT_PRO_MONTHLY` (starts with `price_`)
- [x] `STRIPE_PRICE_AGENT_PRO_YEARLY` (starts with `price_`)
- [x] `STRIPE_PRICE_BUSINESS_MONTHLY` (starts with `price_`)
- [x] `STRIPE_PRICE_BUSINESS_YEARLY` (starts with `price_`)
- [x] `FRONTEND_URL=http://localhost:3001`

## Cleanup

After testing, you can:

1. Stop all terminals (Ctrl+C)
2. Delete test subscriptions from Stripe dashboard
3. Keep `.env.local` for future testing

## Production Deployment

When ready to deploy:

1. **DO NOT** commit `.env.local` to git
2. Use production Stripe keys on Railway
3. Set webhook endpoint in Stripe dashboard to: `https://api.commune.email/api/webhooks/stripe`
4. Use live price IDs in production environment variables
