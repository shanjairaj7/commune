import { z } from 'zod';

export const SearchFilterSchema = z.object({
  organizationId: z.string(),
  inboxIds: z.array(z.string()).optional(),
  participants: z.array(z.string()).optional(),
  domainId: z.string().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
});

export type SearchFilter = z.infer<typeof SearchFilterSchema>;

export interface SearchOptions {
  limit?: number;
  offset?: number;
  minScore?: number;
}

export interface SearchResult {
  id: string;
  score: number;
  metadata: ConversationMetadata;
}

export interface ConversationMetadata {
  organizationId: string;
  inboxId: string;
  domainId: string;
  participants: string[];
  subject: string;
  timestamp: Date;
  threadId: string;
  direction?: 'inbound' | 'outbound';
  attachmentIds?: string[];
  hasAttachments?: boolean;
  attachmentCount?: number;
}

export type SearchType = 'vector' | 'agent';

export interface VectorData {
  id: string;
  vector: number[];
  payload: ConversationMetadata;
}
