import type { Express } from 'express';
import { DefaultRequestHandler, InMemoryPushNotificationStore } from '@a2a-js/sdk/server';
import { agentCardHandler, jsonRpcHandler, restHandler } from '@a2a-js/sdk/server/express';
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
  app.use(
    '/.well-known/agent-card.json',
    agentCardHandler({ agentCardProvider: async () => agentCard }),
  );

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
