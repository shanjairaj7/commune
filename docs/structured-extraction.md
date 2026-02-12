# Structured Data Extraction

Automatically extract structured data from incoming emails using AI-powered extraction with Azure OpenAI.

## Overview

The structured extraction feature allows you to define a JSON schema for each inbox. When emails arrive at that inbox, the system automatically extracts structured data according to your schema and includes it in the webhook payload.

## Key Features

- **JSON Schema-based extraction**: Use standard JSON Schema to define what data to extract
- **Conversation-aware**: Extracts from full conversation context for threaded emails
- **Automatic webhook delivery**: Extracted data included in webhook payloads
- **Per-inbox configuration**: Each inbox can have its own extraction schema

## Setup

### 1. Configure Azure OpenAI

Add these environment variables to your backend:

```bash
AZURE_OPENAI_ENDPOINT=https://your-resource.openai.azure.com
AZURE_OPENAI_API_KEY=your-api-key
AZURE_OPENAI_DEPLOYMENT=gpt-4o
```

### 2. Set Extraction Schema for an Inbox

Use the API to configure extraction for a specific inbox:

```bash
PUT /api/domains/:domainId/inboxes/:inboxId/extraction-schema
```

**Request Body:**

```json
{
  "name": "invoice_extraction",
  "description": "Extract invoice details from incoming emails",
  "enabled": true,
  "schema": {
    "type": "object",
    "properties": {
      "invoiceNumber": {
        "type": "string",
        "description": "The invoice number"
      },
      "amount": {
        "type": "number",
        "description": "The invoice amount in dollars"
      },
      "dueDate": {
        "type": "string",
        "description": "The due date in ISO format"
      },
      "paymentMethod": {
        "type": "string",
        "description": "The payment method"
      },
      "sender": {
        "type": "string",
        "description": "The sender name"
      },
      "senderEmail": {
        "type": "string",
        "description": "The sender email address"
      }
    },
    "required": ["invoiceNumber", "amount", "dueDate"],
    "additionalProperties": false
  }
}
```

**Response:**

```json
{
  "data": {
    "id": "inbox-id",
    "localPart": "billing",
    "address": "billing@yourdomain.com",
    "extractionSchema": {
      "name": "invoice_extraction",
      "description": "Extract invoice details from incoming emails",
      "enabled": true,
      "schema": { ... }
    }
  }
}
```

### 3. Receive Extracted Data in Webhooks

When an email arrives at an inbox with extraction enabled, your webhook receives:

```json
{
  "domainId": "domain-id",
  "inboxId": "inbox-id",
  "inboxAddress": "billing@yourdomain.com",
  "event": { ... },
  "email": { ... },
  "message": {
    "message_id": "msg-123",
    "conversation_id": "conv-456",
    "content": "Email body...",
    "metadata": {
      "extracted_data": {
        "invoiceNumber": "12345",
        "amount": 2500.00,
        "dueDate": "2024-03-15T00:00:00Z",
        "paymentMethod": "Bank Transfer",
        "sender": "John Doe",
        "senderEmail": "john.doe@example.com"
      }
    }
  },
  "extractedData": {
    "invoiceNumber": "12345",
    "amount": 2500.00,
    "dueDate": "2024-03-15T00:00:00Z",
    "paymentMethod": "Bank Transfer",
    "sender": "John Doe",
    "senderEmail": "john.doe@example.com"
  }
}
```

## API Reference

### Set Extraction Schema

```
PUT /api/domains/:domainId/inboxes/:inboxId/extraction-schema
```

**Parameters:**
- `domainId` (path): Domain ID
- `inboxId` (path): Inbox ID

**Body:**
- `name` (required): Schema name
- `description` (optional): Schema description
- `schema` (required): JSON Schema object with `type: "object"` and `properties`
- `enabled` (optional): Enable/disable extraction (default: true)

### Remove Extraction Schema

```
DELETE /api/domains/:domainId/inboxes/:inboxId/extraction-schema
```

**Parameters:**
- `domainId` (path): Domain ID
- `inboxId` (path): Inbox ID

## Example Use Cases

### 1. Support Ticket Extraction

```json
{
  "name": "support_ticket",
  "schema": {
    "type": "object",
    "properties": {
      "priority": {
        "type": "string",
        "description": "Priority level: low, medium, high, urgent"
      },
      "category": {
        "type": "string",
        "description": "Issue category: technical, billing, feature_request, bug"
      },
      "issueDescription": {
        "type": "string",
        "description": "Brief description of the issue"
      },
      "customerName": {
        "type": "string",
        "description": "Customer name"
      },
      "accountId": {
        "type": "string",
        "description": "Customer account ID if mentioned"
      }
    },
    "required": ["priority", "category", "issueDescription"],
    "additionalProperties": false
  }
}
```

### 2. Order Processing

```json
{
  "name": "order_details",
  "schema": {
    "type": "object",
    "properties": {
      "orderNumber": {
        "type": "string",
        "description": "Order number or ID"
      },
      "items": {
        "type": "array",
        "description": "List of ordered items",
        "items": {
          "type": "string"
        }
      },
      "totalAmount": {
        "type": "number",
        "description": "Total order amount"
      },
      "shippingAddress": {
        "type": "string",
        "description": "Shipping address"
      },
      "requestedDeliveryDate": {
        "type": "string",
        "description": "Requested delivery date"
      }
    },
    "required": ["orderNumber", "items", "totalAmount"],
    "additionalProperties": false
  }
}
```

### 3. Meeting Request Extraction

```json
{
  "name": "meeting_request",
  "schema": {
    "type": "object",
    "properties": {
      "proposedDates": {
        "type": "array",
        "description": "Proposed meeting dates",
        "items": {
          "type": "string"
        }
      },
      "duration": {
        "type": "string",
        "description": "Meeting duration"
      },
      "attendees": {
        "type": "array",
        "description": "List of attendees",
        "items": {
          "type": "string"
        }
      },
      "topic": {
        "type": "string",
        "description": "Meeting topic or agenda"
      },
      "location": {
        "type": "string",
        "description": "Meeting location or video call link"
      }
    },
    "required": ["proposedDates", "topic"],
    "additionalProperties": false
  }
}
```

## How It Works

1. **Email Arrives**: An email is received at an inbox with extraction enabled
2. **Context Gathering**: 
   - For single emails: Uses the email content directly
   - For threaded conversations: Retrieves full conversation history for context
3. **AI Extraction**: Calls Azure OpenAI with the email content and your JSON schema
4. **Validation**: Validates extracted data against your schema
5. **Storage**: Stores extracted data in `message.metadata.extracted_data`
6. **Webhook Delivery**: Sends extracted data to your webhook endpoint

## Best Practices

### Schema Design

1. **Be Specific**: Use detailed descriptions for each field
2. **Set Required Fields**: Mark essential fields as required
3. **Use Appropriate Types**: Choose correct JSON types (string, number, boolean, array)
4. **Disable Additional Properties**: Set `additionalProperties: false` for strict validation

### Performance

1. **Keep Schemas Focused**: Extract only what you need
2. **Use Conversation Context**: For multi-email threads, the system automatically provides full context
3. **Monitor Costs**: Each extraction makes an API call to Azure OpenAI

### Error Handling

- Extraction failures are logged but don't block email delivery
- If extraction fails, the webhook still receives the email without `extractedData`
- Check logs for extraction errors and adjust schemas as needed

## Troubleshooting

### No Data Extracted

1. Check Azure OpenAI credentials are configured
2. Verify schema is enabled: `"enabled": true`
3. Review logs for extraction errors
4. Ensure schema descriptions are clear and specific

### Incorrect Data

1. Improve field descriptions in your schema
2. Add examples in descriptions
3. Use more specific field names
4. Test with sample emails

### Missing Fields

1. Check if fields are marked as required
2. Verify the email contains the information
3. Review extraction logs for details

## SDK Integration

When using the SDK, extracted data is available in the webhook payload:

```typescript
// Your webhook handler
app.post('/webhook', (req, res) => {
  const { message, extractedData } = req.body;
  
  if (extractedData) {
    console.log('Extracted invoice:', extractedData);
    // Process the structured data
    processInvoice(extractedData);
  }
  
  res.json({ ok: true });
});
```

## Limits

- Maximum schema size: 2000 tokens
- Maximum extraction response: 2000 tokens
- Conversation context: Up to 50 previous messages

## Security

- Extraction schemas are stored per inbox
- Only organization members can configure schemas
- Extracted data follows same access controls as messages
- API keys required for all schema operations
