/**
 * x402 per-call pricing in USDC.
 *
 * Each key is "METHOD /path" matching the v1 API route.
 * Price strings use dollar prefix (e.g. "$0.003") as required by the x402 protocol.
 * Omitted routes are free (no payment required).
 */

export const X402_PRICES: Record<string, string> = {
  // ── Actions (paid) ─────────────────────────────────────────────
  'POST /v1/messages/send':      '$0.002',   // $5 = 2,500 emails
  'POST /v1/inboxes':            '$0.10',    // $5 = 50 inboxes
  'POST /v1/domains':            '$0.50',    // $5 = 10 domains
  'POST /v1/attachments/upload': '$0.005',   // $5 = 1,000 uploads
  'GET /v1/search':              '$0.001',   // $5 = 5,000 searches

  // ── Reads (free) ───────────────────────────────────────────────
  // GET /v1/messages        — free
  // GET /v1/threads         — free
  // GET /v1/threads/:id     — free
  // GET /v1/me              — free
  // GET /v1/delivery        — free
  // GET /v1/dmarc           — free
};

export const X402_DEFAULT_NETWORK = 'eip155:8453';

export const X402_SUPPORTED_NETWORKS = {
  'eip155:8453':  'Base',
  'eip155:84532': 'Base Sepolia',
  'eip155:137':   'Polygon',
  'eip155:42161': 'Arbitrum One',
  'eip155:1':     'Ethereum',
  'eip155:10':    'Optimism',
  'eip155:43114': 'Avalanche',
  'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp': 'Solana',
  'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1':  'Solana Devnet',
} as const;
