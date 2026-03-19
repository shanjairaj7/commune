/**
 * x402 Payment Gate — enables wallet-based pay-per-call access to Commune.
 *
 * Flow:
 *   1. Request has Authorization header → skip (API key / agent sig handles auth)
 *   2. Request has PAYMENT-SIGNATURE header → verify with facilitator → extract wallet → next()
 *   3. Neither → return 402 with payment requirements
 *
 * After verification, sets req.x402Wallet and req.authType = 'x402'.
 * The auth middleware then uses the wallet address to find/create the org.
 */

import { Response, NextFunction } from 'express';
import { V1AuthenticatedRequest } from './agentSignatureAuth';
import { X402_PRICES, X402_DEFAULT_NETWORK, X402_SUPPORTED_NETWORKS } from '../config/x402Prices';
import logger from '../utils/logger';

// ── Config ────────────────────────────────────────────────────────────────────

const EVM_WALLET = (process.env.COMMUNE_WALLET_ADDRESS || '').trim();
const FACILITATOR_URL = (process.env.X402_FACILITATOR_URL || 'https://x402.org/facilitator').trim();

// USDC contract addresses per network (CAIP-2 → ERC-20 address)
const USDC_CONTRACTS: Record<string, string> = {
  'eip155:8453':  '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // Base
  'eip155:84532': '0x036CbD53842c5426634e7929541eC2318f3dCF7e', // Base Sepolia
  'eip155:137':   '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', // Polygon
  'eip155:42161': '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', // Arbitrum
  'eip155:1':     '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', // Ethereum
  'eip155:10':    '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', // Optimism
  'eip155:43114': '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E', // Avalanche
};

const SOLANA_USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOLANA_WALLET = (process.env.COMMUNE_SOLANA_WALLET_ADDRESS || '').trim();

// ── Types ─────────────────────────────────────────────────────────────────────

export type X402Request = V1AuthenticatedRequest;

interface PaymentAccept {
  scheme: string;
  network: string;
  maxAmountRequired: string;
  resource: string;
  description: string;
  payTo: string;
  asset: string;
  maxTimeoutSeconds: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Convert dollar string "$0.003" to USDC atomic units (6 decimals). */
function dollarToAtomicUnits(price: string): string {
  const dollars = parseFloat(price.replace('$', ''));
  return String(Math.round(dollars * 1_000_000));
}

/** Match request method + path against the price map. */
function matchRoute(method: string, originalUrl: string): string | null {
  const path = originalUrl.split('?')[0];

  // Exact match first
  const exact = `${method} ${path}`;
  if (X402_PRICES[exact]) return exact;

  // Parameterized match: /v1/threads/abc123 → /v1/threads/:threadId
  for (const route of Object.keys(X402_PRICES)) {
    const [routeMethod, routePath] = route.split(' ');
    if (routeMethod !== method) continue;

    const routeParts = routePath.split('/');
    const reqParts = path.split('/');
    if (routeParts.length !== reqParts.length) continue;

    const matches = routeParts.every((part, i) =>
      part.startsWith(':') || part === reqParts[i]
    );
    if (matches) return route;
  }

  return null;
}

/** Build the 402 response body with payment requirements. */
function buildPaymentRequired(routeKey: string): PaymentAccept[] {
  const price = X402_PRICES[routeKey];
  const atomicUnits = dollarToAtomicUnits(price);
  const accepts: PaymentAccept[] = [];

  // Add all supported EVM networks
  for (const network of Object.keys(USDC_CONTRACTS)) {
    if (!X402_SUPPORTED_NETWORKS[network as keyof typeof X402_SUPPORTED_NETWORKS]) continue;
    accepts.push({
      scheme: 'exact',
      network,
      maxAmountRequired: atomicUnits,
      resource: routeKey,
      description: `Commune API: ${routeKey}`,
      payTo: EVM_WALLET,
      asset: USDC_CONTRACTS[network],
      maxTimeoutSeconds: 300,
    });
  }

  // Add Solana if wallet is configured
  if (SOLANA_WALLET) {
    for (const network of Object.keys(X402_SUPPORTED_NETWORKS)) {
      if (!network.startsWith('solana:')) continue;
      accepts.push({
        scheme: 'exact',
        network,
        maxAmountRequired: atomicUnits,
        resource: routeKey,
        description: `Commune API: ${routeKey}`,
        payTo: SOLANA_WALLET,
        asset: SOLANA_USDC,
        maxTimeoutSeconds: 300,
      });
    }
  }

  return accepts;
}

/** Verify payment signature with the facilitator. */
async function verifyPayment(
  paymentSignature: string,
  paymentRequired: PaymentAccept[],
): Promise<{ valid: boolean; walletAddress?: string }> {
  try {
    const resp = await fetch(`${FACILITATOR_URL}/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        payload: paymentSignature,
        requirements: paymentRequired,
      }),
    });

    if (!resp.ok) {
      logger.warn('x402 facilitator verification failed', { status: resp.status });
      return { valid: false };
    }

    const result = await resp.json() as { valid?: boolean; payer?: string };
    if (!result.valid) return { valid: false };

    // Extract payer wallet address
    const walletAddress = result.payer || extractWalletFromSignature(paymentSignature);
    return { valid: true, walletAddress };
  } catch (err) {
    logger.error('x402 facilitator request error', { error: err });
    return { valid: false };
  }
}

/** Settle payment with the facilitator after serving the request. */
async function settlePayment(paymentSignature: string): Promise<void> {
  try {
    await fetch(`${FACILITATOR_URL}/settle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payload: paymentSignature }),
    });
  } catch (err) {
    logger.error('x402 settlement error', { error: err });
  }
}

/** Best-effort extraction of wallet address from base64-encoded payment signature. */
function extractWalletFromSignature(sig: string): string | undefined {
  try {
    const decoded = JSON.parse(Buffer.from(sig, 'base64').toString());
    return decoded?.payload?.authorization?.from || decoded?.from || undefined;
  } catch {
    return undefined;
  }
}

// ── Middleware ─────────────────────────────────────────────────────────────────

/**
 * x402 payment gate middleware.
 *
 * Mount BEFORE v1CombinedAuth in the v1 router.
 * - Requests with Authorization header → pass through to existing auth.
 * - Requests with PAYMENT-SIGNATURE → verify payment, set x402 context.
 * - Free routes (not in price map) → pass through.
 * - Paid routes with no auth and no payment → return 402.
 */
export const x402PaymentGate = async (
  req: X402Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  // Skip if x402 is not configured
  if (!EVM_WALLET) {
    return next();
  }

  // Skip for requests with API key or agent signature — existing auth handles them
  if (req.headers.authorization) {
    return next();
  }

  // Check if this is a paid route
  const routeKey = matchRoute(req.method, req.originalUrl);
  if (!routeKey) {
    // Free route, but no auth either — let auth middleware handle the 401
    return next();
  }

  // Paid route, no auth header — check for x402 payment
  const paymentSignature = req.headers['payment-signature'] as string | undefined;
  if (!paymentSignature) {
    // Return 402 with payment requirements
    const accepts = buildPaymentRequired(routeKey);
    res.status(402)
      .setHeader('PAYMENT-REQUIRED', Buffer.from(JSON.stringify(accepts)).toString('base64'))
      .json({
        error: 'payment_required',
        message: 'Pay with x402 or provide an API key',
        price: X402_PRICES[routeKey],
        accepts,
      });
    return;
  }

  // Verify the payment with the facilitator
  const paymentRequired = buildPaymentRequired(routeKey);
  const { valid, walletAddress } = await verifyPayment(paymentSignature, paymentRequired);

  if (!valid) {
    res.status(402).json({
      error: 'payment_invalid',
      message: 'Payment verification failed. Check your wallet balance and try again.',
    });
    return;
  }

  if (!walletAddress) {
    res.status(402).json({
      error: 'payment_invalid',
      message: 'Could not extract wallet address from payment.',
    });
    return;
  }

  // Payment verified — set x402 context for the auth middleware
  req.x402Wallet = walletAddress;
  req.authType = 'x402';

  logger.info('x402 payment verified', {
    wallet: walletAddress,
    route: routeKey,
    price: X402_PRICES[routeKey],
  });

  // Settle payment only after a successful response (don't charge for errors)
  res.on('finish', () => {
    if (res.statusCode >= 200 && res.statusCode < 300) {
      settlePayment(paymentSignature).catch((err) => {
        logger.error('x402 settlement failed — payment verified but not settled', {
          wallet: walletAddress,
          route: routeKey,
          error: err,
        });
      });
    }
  });

  next();
};
