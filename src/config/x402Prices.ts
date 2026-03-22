/**
 * x402 per-call pricing in USDC.
 *
 * Each key is "METHOD /path" matching the v1 API route.
 * Price strings use dollar prefix (e.g. "$0.003") as required by the x402 protocol.
 * Omitted routes are free (no payment required).
 */

export const X402_PRICES: Record<string, string> = {
  'POST /v1/messages/send':      '$0.003',
  'POST /v1/inboxes':            '$0.01',
  'POST /v1/domains':            '$0.05',
  'POST /v1/attachments/upload': '$0.005',
  'GET /v1/messages':            '$0.001',
  'GET /v1/threads':             '$0.001',
  'GET /v1/threads/:threadId':   '$0.001',
  'GET /v1/search':              '$0.002',
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
