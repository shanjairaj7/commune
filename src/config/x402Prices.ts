/**
 * x402 per-call pricing in USDC.
 *
 * Each key is "METHOD /path" matching the v1 API route.
 * Price strings use dollar prefix (e.g. "$0.003") as required by the x402 protocol.
 * Omitted routes are free (no payment required).
 */

export const X402_PRICES: Record<string, string> = {
  // ── Core actions ───────────────────────────────────────────────
  'POST /v1/messages/send':      '$0.003',
  'POST /v1/inboxes':            '$0.01',
  'POST /v1/domains':            '$0.05',
  'POST /v1/attachments/upload': '$0.005',

  // ── Reads ──────────────────────────────────────────────────────
  'GET /v1/messages':            '$0.001',
  'GET /v1/threads':             '$0.001',
  'GET /v1/threads/:threadId':   '$0.001',
  'GET /v1/search':              '$0.002',

  // ── Free (not listed = free, but explicit for clarity) ─────────
  // GET /v1/me
  // GET /v1/dmarc
  // GET /v1/delivery
  // GET /v1/domains
  // GET /v1/inboxes
  // GET /v1/webhooks
};

/**
 * Default network for x402 payments (CAIP-2 format).
 * Base mainnet — cheapest gas, widest USDC liquidity.
 */
export const X402_DEFAULT_NETWORK = 'eip155:8453';

/**
 * All networks we accept payments on.
 */
export const X402_SUPPORTED_NETWORKS = {
  // EVM
  'eip155:8453':  'Base',
  'eip155:84532': 'Base Sepolia',
  'eip155:137':   'Polygon',
  'eip155:42161': 'Arbitrum One',
  'eip155:1':     'Ethereum',
  'eip155:10':    'Optimism',
  'eip155:43114': 'Avalanche',
  // Solana
  'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp': 'Solana',
  'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1':  'Solana Devnet',
} as const;
