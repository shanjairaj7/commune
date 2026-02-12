import { QdrantClient } from '@qdrant/js-client-rest';
import logger from '../utils/logger';
import { SearchFilter, SearchOptions, SearchResult, VectorData, ConversationMetadata } from '../types/search';
import { FilterCondition, FieldCondition } from '../types/qdrant';
import { randomUUID } from 'crypto';

export class QdrantService {
  private client: QdrantClient;
  private static instance: QdrantService;

  private constructor() {
    const url = process.env.QDRANT_URL;
    const apiKey = process.env.QDRANT_API_KEY;

    if (!url || !apiKey) {
      throw new Error('QDRANT_URL and QDRANT_API_KEY must be set in environment');
    }

    this.client = new QdrantClient({ url, apiKey });
  }

  public static getInstance(): QdrantService {
    if (!QdrantService.instance) {
      QdrantService.instance = new QdrantService();
    }
    return QdrantService.instance;
  }

  public async initializeCollection(organizationId: string): Promise<void> {
    const collectionName = this.getCollectionName(organizationId);

    try {
      // Check if collection exists
      const collections = await this.client.getCollections();
      const exists = collections.collections.some(c => c.name === collectionName);
      
      if (exists) {
        logger.info(`Collection ${collectionName} already exists`);
        return;
      }

      // Create new collection
      await this.client.createCollection(collectionName, {
        vectors: {
          size: 1536, // embed-v-4-0 dimension
          distance: 'Cosine',
        },
        replication_factor: 2, // For high availability
        write_consistency_factor: 2,
        on_disk_payload: true,
      });

      // Create payload indexes for efficient filtering
      await this.client.createPayloadIndex(collectionName, {
        field_name: 'organizationId',
        field_schema: 'keyword',
      });

      await this.client.createPayloadIndex(collectionName, {
        field_name: 'inboxId',
        field_schema: 'keyword',
      });

      await this.client.createPayloadIndex(collectionName, {
        field_name: 'domainId',
        field_schema: 'keyword',
      });

      await this.client.createPayloadIndex(collectionName, {
        field_name: 'participants',
        field_schema: 'keyword',
      });

      await this.client.createPayloadIndex(collectionName, {
        field_name: 'timestamp',
        field_schema: 'datetime',
      });

      logger.info(`Initialized collection for organization: ${organizationId}`);
    } catch (error) {
      logger.error('Error initializing collection:', error);
      throw new Error('Failed to initialize collection');
    }
  }

  public async upsertVectors(organizationId: string, vectors: VectorData[]): Promise<void> {
    try {
      // Ensure collection exists before upserting
      await this.initializeCollection(organizationId);
      
      const collectionName = this.getCollectionName(organizationId);
      
      // Convert string IDs to UUIDs for Qdrant compatibility
      const points = vectors.map(v => {
        // Generate a UUID from the string ID if it's not already a valid UUID
        const id = this.isValidUUID(v.id) ? v.id : this.stringToUUID(v.id);
        
        return {
          id,
          vector: v.vector,
          payload: {
            ...v.payload,
            // Store original message_id in payload for reference
            messageId: v.id,
            timestamp: v.payload.timestamp.toISOString(),
          },
        };
      });
      
      await this.client.upsert(collectionName, {
        wait: true,
        points,
      });

      logger.info(`Upserted ${vectors.length} vectors for organization: ${organizationId}`);
    } catch (error) {
      logger.error('Error upserting vectors:', error);
      throw new Error('Failed to upsert vectors');
    }
  }

  public async search(
    organizationId: string,
    queryVector: number[],
    filter: SearchFilter,
    options: SearchOptions = {}
  ): Promise<SearchResult[]> {
    try {
      const collectionName = this.getCollectionName(organizationId);
      const { limit = 10, offset = 0, minScore = 0.15 } = options;

      // Build filter conditions with strict organization isolation
      // Build filter conditions with strict organization isolation
      const must = [
        {
          key: 'organizationId',
          match: { value: organizationId }
        }
      ];

      // Handle inbox filtering
      if (filter.inboxIds?.length) {
        must.push({
          key: 'inboxId',
          match: { value: filter.inboxIds[0] } // For now, use first inbox
        });
      }

      // Handle domain filtering
      if (filter.domainId) {
        must.push({
          key: 'domainId',
          match: { value: filter.domainId }
        });
      }

      // Handle participant filtering
      if (filter.participants?.length) {
        must.push({
          key: 'participants',
          match: { value: filter.participants[0] } // For now, use first participant
        });
      }

      // Handle date range filtering
      if (filter.startDate || filter.endDate) {
        must.push({
          key: 'timestamp',
          match: { value: filter.startDate || filter.endDate || new Date().toISOString() }
        });
      }

      const response = await this.client.search(collectionName, {
        vector: queryVector,
        limit,
        offset,
        score_threshold: minScore,
        filter: { must },
        with_payload: true,
        with_vector: false, // Don't return vectors for security
      });

      return response.map(hit => {
        const payload = hit.payload || {};
        return {
          id: hit.id as string,
          score: hit.score,
          metadata: {
            ...payload as any,
            timestamp: new Date(payload.timestamp as string || new Date().toISOString()),
          } as ConversationMetadata,
        };
      });
    } catch (error) {
      logger.error('Error searching vectors:', error);
      throw new Error('Failed to search vectors');
    }
  }

  private getCollectionName(organizationId: string): string {
    return `org_${organizationId}_conversations`;
  }

  private isValidUUID(str: string): boolean {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    return uuidRegex.test(str);
  }

  private stringToUUID(str: string): string {
    // Create a deterministic UUID from a string using MD5-like approach
    // This ensures the same string always produces the same UUID
    const hash = this.simpleHash(str);
    
    // Format as UUID v4
    return [
      hash.substring(0, 8),
      hash.substring(8, 12),
      '4' + hash.substring(13, 16),
      '8' + hash.substring(17, 20),
      hash.substring(20, 32),
    ].join('-');
  }

  private simpleHash(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    // Create a hex string from the hash and pad it
    const hexHash = Math.abs(hash).toString(16).padStart(32, '0');
    return hexHash + hexHash; // Double it to get 64 chars
  }
}
