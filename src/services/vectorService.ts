import OpenAI from 'openai';
import logger from '../utils/logger';

interface Conversation {
  subject: string;
  content: string;
  metadata?: Record<string, unknown>;
}

export class VectorService {
  private openai: OpenAI;
  private static instance: VectorService;

  private constructor() {
    const apiKey = process.env.AZURE_OPENAI_EMBEDDING_API_KEY;
    const endpoint = process.env.AZURE_OPENAI_EMBEDDING_ENDPOINT;
    
    if (!apiKey || !endpoint) {
      throw new Error('AZURE_OPENAI_EMBEDDING_API_KEY and AZURE_OPENAI_EMBEDDING_ENDPOINT must be set in environment');
    }
    
    this.openai = new OpenAI({
      baseURL: endpoint,
      apiKey,
      defaultHeaders: { "api-key": apiKey }
    });
  }

  public static getInstance(): VectorService {
    if (!VectorService.instance) {
      VectorService.instance = new VectorService();
    }
    return VectorService.instance;
  }

  public async generateEmbedding(text: string): Promise<number[]> {
    try {
      const deployment = process.env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT || 'embed-v-4-0';
      const response = await this.openai.embeddings.create({
        model: deployment,
        input: [text], // Azure expects array
        encoding_format: "float"
      });

      return response.data[0].embedding;
    } catch (error) {
      logger.error('Error generating embedding:', error);
      throw new Error('Failed to generate embedding');
    }
  }

  public async generateEmbeddingsBatch(texts: string[]): Promise<number[][]> {
    try {
      const deployment = process.env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT || 'embed-v-4-0';
      const response = await this.openai.embeddings.create({
        model: deployment,
        input: texts,
        encoding_format: "float"
      });

      return response.data.map((item: { embedding: number[] }) => item.embedding);
    } catch (error) {
      logger.error('Error generating embeddings batch:', error);
      throw new Error('Failed to generate embeddings batch');
    }
  }

  public async prepareConversationText(conversation: Conversation): Promise<string> {
    // Combine relevant fields into a searchable text
    const metadata = conversation.metadata ? 
      Object.entries(conversation.metadata)
        .map(([key, value]) => `${key}: ${value}`)
        .join('\n') : '';

    return [
      conversation.subject,
      conversation.content,
      metadata
    ].filter(Boolean).join('\n');
  }
}
