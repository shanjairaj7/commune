import { Router, json } from 'express';
import { requirePermission } from '../../middleware/permissions';
import { requireFeature } from '../../middleware/planGate';
import messageStore from '../../stores/messageStore';
import logger from '../../utils/logger';

const router = Router();

/**
 * Attempt vector search via SearchService (Qdrant + Azure OpenAI embeddings).
 * Returns null if the vector stack is not configured or fails, so we can fall back to regex.
 */
const tryVectorSearch = async (
  orgId: string,
  query: string,
  inboxId?: string,
  domainId?: string,
  limit = 20,
): Promise<any[] | null> => {
  try {
    // Only attempt if embedding + Qdrant env vars are set
    if (!process.env.QDRANT_URL || !process.env.AZURE_OPENAI_EMBEDDING_API_KEY) {
      return null;
    }

    const { SearchService } = await import('../../services/searchService');
    const searchService = SearchService.getInstance();

    const results = await searchService.search(orgId, query, {
      organizationId: orgId,
      inboxIds: inboxId ? [inboxId] : undefined,
      domainId,
    }, { limit, minScore: 0.15 });

    if (!results || results.length === 0) return null;

    // Map vector results to thread-like format
    return results.map((r) => ({
      thread_id: r.metadata.threadId,
      subject: r.metadata.subject,
      score: r.score,
      inbox_id: r.metadata.inboxId,
      domain_id: r.metadata.domainId,
      participants: r.metadata.participants,
      direction: r.metadata.direction,
    }));
  } catch (err) {
    logger.warn('Vector search unavailable, falling back to regex', { error: (err as Error).message });
    return null;
  }
};

/**
 * GET /v1/search/threads
 * Search threads by natural language query.
 *
 * Uses vector search (Qdrant + embeddings) when available,
 * falls back to regex-based subject/content search.
 *
 * Query params:
 *   q         - Search query (required)
 *   inbox_id  - Filter by inbox (recommended)
 *   domain_id - Filter by domain
 *   limit     - Max results (1-100, default 20)
 */
router.get('/threads', requireFeature('semanticSearch'), requirePermission('threads:read'), async (req: any, res) => {
  const orgId = req.orgId;
  const query = (req.query.q as string || '').trim();
  const inboxId = req.query.inbox_id as string | undefined;
  const domainId = req.query.domain_id as string | undefined;
  const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);

  if (!query) {
    return res.status(400).json({ error: 'Missing required query parameter: q' });
  }

  if (!inboxId && !domainId) {
    return res.status(400).json({ error: 'inbox_id or domain_id is required' });
  }

  try {
    // Try vector search first (semantic, better quality)
    const vectorResults = await tryVectorSearch(orgId, query, inboxId, domainId, limit);
    if (vectorResults) {
      return res.json({ data: vectorResults, search_type: 'vector' });
    }

    // Fallback: regex-based text search
    const results = await messageStore.searchThreads({
      query,
      inboxId,
      domainId,
      orgId,
      limit,
    });

    return res.json({ data: results, search_type: 'regex' });
  } catch (err) {
    logger.error('v1: Thread search failed', { orgId, query, error: err });
    return res.status(500).json({ error: 'Search failed' });
  }
});

/**
 * POST /v1/search
 * Deprecated compatibility route for old SDK clients.
 * Canonical route is GET /v1/search/threads.
 */
router.post('/', json(), requireFeature('semanticSearch'), requirePermission('threads:read'), async (req: any, res) => {
  const query = (req.body?.query as string || '').trim();
  const filter = req.body?.filter || {};
  const options = req.body?.options || {};
  const inboxId = Array.isArray(filter.inboxIds) && filter.inboxIds.length > 0 ? filter.inboxIds[0] : undefined;
  const domainId = filter.domainId as string | undefined;
  const limit = Math.min(Math.max(Number(options.limit) || 20, 1), 100);

  if (!query) {
    return res.status(400).json({ error: 'Missing required field: query' });
  }
  if (!inboxId && !domainId) {
    return res.status(400).json({ error: 'inbox_id or domain_id is required' });
  }

  try {
    const orgId = req.orgId;
    const vectorResults = await tryVectorSearch(orgId, query, inboxId, domainId, limit);
    if (vectorResults) {
      return res.json({ data: vectorResults });
    }

    const results = await messageStore.searchThreads({
      query,
      inboxId,
      domainId,
      orgId,
      limit,
    });
    return res.json({ data: results });
  } catch (err) {
    logger.error('v1: Legacy search endpoint failed', { error: err });
    return res.status(500).json({ error: 'Search failed' });
  }
});

/**
 * POST /v1/search/index
 * Deprecated compatibility route. Indexing is automatic.
 */
router.post('/index', json(), requireFeature('semanticSearch'), async (_req: any, res) => {
  return res.json({ data: { success: true } });
});

/**
 * POST /v1/search/index/batch
 * Deprecated compatibility route. Indexing is automatic.
 */
router.post('/index/batch', json(), requireFeature('semanticSearch'), async (_req: any, res) => {
  return res.json({ data: { success: true } });
});

export default router;
