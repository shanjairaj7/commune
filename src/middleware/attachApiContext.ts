/**
 * Middleware that normalizes the apiKey context on the request object.
 * Ensures downstream route handlers always see { orgId, source } on req.apiKey,
 * regardless of whether authentication came from JWT or API key.
 */
export const attachApiContext = (req: any, _res: any, next: any) => {
  if (!req.apiKey || typeof req.apiKey === 'string') {
    const orgId = req.orgId ?? req.user?.orgId ?? null;
    const source = req.authType ?? (req.apiKey ? 'apikey' : 'jwt');
    req.apiKey = { orgId, source };
  }
  next();
};
