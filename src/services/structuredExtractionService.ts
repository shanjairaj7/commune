import logger from '../utils/logger';

const AZURE_OPENAI_ENDPOINT = process.env.AZURE_OPENAI_ENDPOINT || '';
const AZURE_OPENAI_KEY = process.env.AZURE_OPENAI_API_KEY || '';
const AZURE_OPENAI_DEPLOYMENT = process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-4o';

interface EmailContent {
  from: string;
  to?: string;
  subject?: string;
  body: string;
  date?: string;
  messageId?: string;
}

interface ConversationMessage {
  from: string;
  to?: string;
  subject?: string;
  body: string;
  date: string;
  messageId: string;
}

export class StructuredExtractionService {
  private static isConfigured(): boolean {
    return !!(AZURE_OPENAI_ENDPOINT && AZURE_OPENAI_KEY);
  }

  /**
   * Extract structured data from a single email using Azure OpenAI
   */
  static async extractFromEmail(
    email: EmailContent,
    jsonSchema: Record<string, any>,
    schemaName: string = 'email_extraction'
  ): Promise<Record<string, any> | null> {
    if (!this.isConfigured()) {
      logger.warn('Azure OpenAI not configured, skipping structured extraction');
      return null;
    }

    try {
      const apiVersion = '2024-08-01-preview';
      const url = `${AZURE_OPENAI_ENDPOINT}/openai/deployments/${AZURE_OPENAI_DEPLOYMENT}/chat/completions?api-version=${apiVersion}`;

      const emailContent = `From: ${email.from}
${email.to ? `To: ${email.to}` : ''}
${email.subject ? `Subject: ${email.subject}` : ''}
${email.date ? `Date: ${email.date}` : ''}

${email.body}`;

      const requestBody = {
        messages: [
          {
            role: 'system',
            content: 'Extract structured data from emails according to the provided schema. Return only valid JSON matching the schema.'
          },
          {
            role: 'user',
            content: `Extract data from this email:\n\n${emailContent}`
          }
        ],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: schemaName,
            strict: true,
            schema: jsonSchema
          }
        },
        temperature: 0.1,
        max_tokens: 4000
      };

      logger.info('Making Azure OpenAI structured extraction request', {
        schemaName,
        emailFrom: email.from,
        emailSubject: email.subject
      });

      // Iterative extraction loop for reasoning models
      let messages = requestBody.messages;
      let maxIterations = 5;
      let iteration = 0;

      while (iteration < maxIterations) {
        iteration++;
        
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'api-key': AZURE_OPENAI_KEY
          },
          body: JSON.stringify({ ...requestBody, messages })
        });

        if (!response.ok) {
          const errorText = await response.text();
          logger.error('Azure OpenAI API request failed', {
            status: response.status,
            statusText: response.statusText,
            error: errorText,
            iteration
          });
          return null;
        }

        const data = await response.json();
        const message = data.choices[0]?.message;
        
        // Check if we have structured output in content
        let extractedContent = message?.content;
        
        if (extractedContent && extractedContent.trim()) {
          // Try to parse as JSON
          try {
            const parsed = JSON.parse(extractedContent);
            logger.info('Successfully extracted structured data', {
              schemaName,
              extractedFields: Object.keys(parsed),
              iterations: iteration
            });
            return parsed;
          } catch (parseError) {
            // Content exists but isn't valid JSON, continue loop
            logger.warn('Content is not valid JSON, continuing', { iteration });
          }
        }
        
        // If we have reasoning content, pass it back to continue
        if (message?.reasoning_content) {
          logger.info('Model returned reasoning, passing back for continuation', {
            iteration,
            reasoningLength: message.reasoning_content.length
          });
          
          // Add the assistant's reasoning as a message and ask for the JSON output
          messages = [
            ...messages,
            {
              role: 'assistant',
              content: message.reasoning_content
            },
            {
              role: 'user',
              content: 'Now provide the final JSON output based on your reasoning above.'
            }
          ];
          
          continue;
        }
        
        // No content and no reasoning, cannot continue
        logger.warn('No content or reasoning in response', {
          iteration,
          finishReason: data.choices[0]?.finish_reason
        });
        break;
      }

      logger.error('Failed to extract structured data after iterations', {
        schemaName,
        iterations: iteration
      });
      return null;
    } catch (error) {
      logger.error('Structured extraction failed', {
        error: error instanceof Error ? error.message : String(error),
        schemaName
      });
      return null;
    }
  }

  /**
   * Extract structured data from a conversation thread
   * Provides full conversation context for better extraction
   */
  static async extractFromConversation(
    messages: ConversationMessage[],
    jsonSchema: Record<string, any>,
    schemaName: string = 'conversation_extraction'
  ): Promise<Record<string, any> | null> {
    if (!this.isConfigured()) {
      logger.warn('Azure OpenAI not configured, skipping structured extraction');
      return null;
    }

    try {
      const apiVersion = '2024-08-01-preview';
      const url = `${AZURE_OPENAI_ENDPOINT}/openai/deployments/${AZURE_OPENAI_DEPLOYMENT}/chat/completions?api-version=${apiVersion}`;

      // Build conversation context
      const conversationContext = messages
        .map((msg, idx) => {
          return `[Message ${idx + 1}]
From: ${msg.from}
${msg.to ? `To: ${msg.to}` : ''}
${msg.subject ? `Subject: ${msg.subject}` : ''}
Date: ${msg.date}

${msg.body}`;
        })
        .join('\n\n---\n\n');

      const requestBody = {
        messages: [
          {
            role: 'system',
            content: 'Extract structured data from email conversations according to the schema. Analyze the full thread. Return only valid JSON.'
          },
          {
            role: 'user',
            content: `Extract data from this conversation:\n\n${conversationContext}`
          }
        ],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: schemaName,
            strict: true,
            schema: jsonSchema
          }
        },
        temperature: 0.1,
        max_tokens: 4000
      };

      logger.info('Making Azure OpenAI conversation extraction request', {
        schemaName,
        messageCount: messages.length
      });

      // Iterative extraction loop for reasoning models
      let conversationMessages = requestBody.messages;
      let maxIterations = 5;
      let iteration = 0;

      while (iteration < maxIterations) {
        iteration++;
        
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'api-key': AZURE_OPENAI_KEY
          },
          body: JSON.stringify({ ...requestBody, messages: conversationMessages })
        });

        if (!response.ok) {
          const errorText = await response.text();
          logger.error('Azure OpenAI API request failed', {
            status: response.status,
            statusText: response.statusText,
            error: errorText,
            iteration
          });
          return null;
        }

        const data = await response.json();
        const message = data.choices[0]?.message;
        
        // Check if we have structured output in content
        let extractedContent = message?.content;
        
        if (extractedContent && extractedContent.trim()) {
          // Try to parse as JSON
          try {
            const parsed = JSON.parse(extractedContent);
            logger.info('Successfully extracted structured data from conversation', {
              schemaName,
              messageCount: messages.length,
              extractedFields: Object.keys(parsed),
              iterations: iteration
            });
            return parsed;
          } catch (parseError) {
            // Content exists but isn't valid JSON, continue loop
            logger.warn('Content is not valid JSON, continuing', { iteration });
          }
        }
        
        // If we have reasoning content, pass it back to continue
        if (message?.reasoning_content) {
          logger.info('Model returned reasoning, passing back for continuation', {
            iteration,
            reasoningLength: message.reasoning_content.length
          });
          
          // Add the assistant's reasoning as a message and ask for the JSON output
          conversationMessages = [
            ...conversationMessages,
            {
              role: 'assistant',
              content: message.reasoning_content
            },
            {
              role: 'user',
              content: 'Now provide the final JSON output based on your reasoning above.'
            }
          ];
          
          continue;
        }
        
        // No content and no reasoning, cannot continue
        logger.warn('No content or reasoning in response', {
          iteration,
          finishReason: data.choices[0]?.finish_reason
        });
        break;
      }

      logger.error('Failed to extract structured data from conversation after iterations', {
        schemaName,
        iterations: iteration
      });
      return null;
    } catch (error) {
      logger.error('Conversation extraction failed', {
        error: error instanceof Error ? error.message : String(error),
        schemaName,
        messageCount: messages.length
      });
      return null;
    }
  }
}
