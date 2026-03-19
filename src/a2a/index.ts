import type { Express } from 'express';
import { DefaultRequestHandler } from '@a2a-js/sdk/server';
import { jsonRpcHandler, restHandler } from '@a2a-js/sdk/server/express';
import { agentCard } from './agentCard';
import { MongoTaskStore } from './taskStore';
import { CommuneAgentExecutor } from './executor';
import { communeUserBuilder } from './userBuilder';
import { v1CombinedAuth } from '../middleware/agentSignatureAuth';
import { x402PaymentGate } from '../middleware/x402PaymentGate';
import logger from '../utils/logger';

/**
 * Mount A2A protocol endpoints on the Express app.
 *
 * Layout:
 *   GET  /.well-known/agent-card.json  → Agent Card (public, no auth)
 *   POST /a2a                          → JSON-RPC handler (auth required)
 *   *    /a2a/v1/*                     → REST handler (auth required)
 */
export function mountA2A(app: Express): void {
  const taskStore = new MongoTaskStore();
  const executor = new CommuneAgentExecutor();

  const requestHandler = new DefaultRequestHandler(
    agentCard,
    taskStore,
    executor,
  );

  // ── Agent Card: public, no auth ───────────────────────────────────────
  // Direct GET handler (app.use with dot-paths can be unreliable in some Express versions)
  app.get('/.well-known/agent-card.json', (_req, res) => {
    res.json(agentCard);
  });
  // Also serve at /a2a/agent-card.json as a convenience alias
  app.get('/a2a/agent-card.json', (_req, res) => {
    res.json(agentCard);
  });

  // ── JSON-RPC transport: auth required ─────────────────────────────────
  // The x402 gate + v1CombinedAuth middleware runs first, populating req.orgId.
  // Then the A2A JSON-RPC handler processes the message.
  app.use(
    '/a2a',
    x402PaymentGate,
    v1CombinedAuth,
    jsonRpcHandler({ requestHandler, userBuilder: communeUserBuilder }),
  );

  // ── REST transport: auth required ─────────────────────────────────────
  app.use(
    '/a2a/v1',
    x402PaymentGate,
    v1CombinedAuth,
    restHandler({ requestHandler, userBuilder: communeUserBuilder }),
  );

  logger.info('A2A protocol endpoints mounted', {
    agentCard: '/.well-known/agent-card.json',
    jsonRpc: '/a2a',
    rest: '/a2a/v1/*',
    skills: agentCard.skills.map((s) => s.id),
  });
}
