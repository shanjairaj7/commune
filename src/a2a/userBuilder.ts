import type { Request } from 'express';
import type { User } from '@a2a-js/sdk/server';
import { UnauthenticatedUser } from '@a2a-js/sdk/server';
import type { V1AuthenticatedRequest } from '../middleware/agentSignatureAuth';

/**
 * A2A User that carries Commune org context.
 *
 * After our v1CombinedAuth middleware runs, req.orgId is set.
 * This user class makes that context available to the AgentExecutor.
 */
export class CommuneUser implements User {
  constructor(
    public readonly orgId: string,
    public readonly authType: string,
    public readonly apiKeyData?: V1AuthenticatedRequest['apiKeyData'],
    public readonly agentId?: string,
  ) {}

  get isAuthenticated(): boolean {
    return true;
  }

  get userName(): string {
    return this.orgId;
  }
}

/**
 * UserBuilder for A2A SDK.
 *
 * Extracts authenticated org context from the Express request
 * (already populated by v1CombinedAuth middleware upstream).
 */
export async function communeUserBuilder(req: Request): Promise<User> {
  const authReq = req as V1AuthenticatedRequest;
  if (authReq.orgId) {
    return new CommuneUser(
      authReq.orgId,
      authReq.authType || 'apikey',
      authReq.apiKeyData,
      authReq.agentId,
    );
  }
  return new UnauthenticatedUser();
}
