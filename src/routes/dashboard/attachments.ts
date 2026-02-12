import { Router } from 'express';
import messageStore from '../../stores/messageStore';
import { AttachmentStorageService } from '../../services/attachmentStorageService';
import logger from '../../utils/logger';
import crypto from 'crypto';

const router = Router();

// Upload attachment for later use in email sending
router.post('/upload', async (req, res) => {
  const { content, filename, mimeType } = req.body;
  const orgId = (req as any).apiKey?.orgId || null;

  if (!content || !filename || !mimeType) {
    return res.status(400).json({ error: 'Missing required fields: content, filename, mimeType' });
  }

  try {
    // Decode base64 content
    const buffer = Buffer.from(content, 'base64');
    const attachmentStorageService = AttachmentStorageService.getInstance();
    
    // Upload to Cloudinary or store as base64
    const uploadResult = await attachmentStorageService.uploadAttachment(
      buffer,
      filename,
      mimeType,
      orgId
    );

    // Generate attachment ID
    const attachmentId = crypto.randomBytes(16).toString('hex');
    
    // Store attachment record
    const attachmentRecord = {
      attachment_id: attachmentId,
      message_id: '', // Will be set when email is sent
      filename,
      mime_type: mimeType,
      size: buffer.length,
      content_base64: uploadResult.storage_type === 'database' ? content : null,
      storage_type: uploadResult.storage_type,
      cloudinary_url: uploadResult.cloudinary_url || null,
      cloudinary_public_id: uploadResult.cloudinary_public_id || null,
      source: 'email' as const,
    };

    await messageStore.insertAttachments([attachmentRecord]);

    logger.info('Uploaded attachment', { 
      orgId, 
      attachmentId, 
      filename,
      storageType: uploadResult.storage_type 
    });

    return res.json({ 
      data: { 
        attachment_id: attachmentId,
        filename,
        mime_type: mimeType,
        size: buffer.length,
        storage_type: uploadResult.storage_type,
      } 
    });
  } catch (err) {
    logger.error('Failed to upload attachment', { orgId, filename, error: err });
    return res.status(500).json({ error: 'Failed to upload attachment' });
  }
});

router.get('/:attachmentId', async (req, res) => {
  const { attachmentId } = req.params;
  const includeContent = req.query.includeContent === 'true';
  const orgId = (req as any).apiKey?.orgId || null;

  try {
    const attachment = await messageStore.getAttachment(attachmentId);
    
    if (!attachment) {
      return res.status(404).json({ error: 'Attachment not found' });
    }

    // Return metadata only (no base64 content) unless explicitly requested
    if (!includeContent) {
      const { content_base64, ...metadata } = attachment;
      logger.info('Fetched attachment metadata', { orgId, attachmentId });
      return res.json({ data: metadata });
    }

    // Include full content if requested
    logger.info('Fetched attachment with content', { orgId, attachmentId });
    return res.json({ data: attachment });
  } catch (err) {
    logger.error('Failed to fetch attachment', { orgId, attachmentId, error: err });
    return res.status(500).json({ error: 'Failed to fetch attachment' });
  }
});

router.get('/:attachmentId/url', async (req, res) => {
  const { attachmentId } = req.params;
  const expiresIn = parseInt(req.query.expiresIn as string) || 3600;
  const orgId = (req as any).apiKey?.orgId || null;

  try {
    const attachment = await messageStore.getAttachment(attachmentId);
    
    if (!attachment) {
      return res.status(404).json({ error: 'Attachment not found' });
    }

    // If stored in Cloudinary, generate signed URL
    if (attachment.storage_type === 'cloudinary' && attachment.cloudinary_public_id) {
      const attachmentStorageService = AttachmentStorageService.getInstance();
      
      if (!attachmentStorageService.isCloudinaryConfigured()) {
        return res.status(500).json({ error: 'Cloudinary not configured' });
      }

      const signedUrl = await attachmentStorageService.generateSignedUrl(
        attachment.cloudinary_public_id,
        expiresIn
      );

      logger.info('Generated signed URL for attachment', { 
        orgId, 
        attachmentId,
        expiresIn 
      });

      return res.json({ 
        data: { 
          url: signedUrl,
          expiresIn,
          filename: attachment.filename,
          mimeType: attachment.mime_type,
          size: attachment.size,
        } 
      });
    }

    // If stored in database, return base64 data URL
    if (attachment.storage_type === 'database' && attachment.content_base64) {
      const dataUrl = `data:${attachment.mime_type};base64,${attachment.content_base64}`;
      
      logger.info('Generated data URL for attachment', { orgId, attachmentId });
      
      return res.json({ 
        data: { 
          url: dataUrl,
          expiresIn: 0, // Data URLs don't expire
          filename: attachment.filename,
          mimeType: attachment.mime_type,
          size: attachment.size,
        } 
      });
    }

    return res.status(400).json({ error: 'Attachment has no accessible content' });
  } catch (err) {
    logger.error('Failed to generate attachment URL', { orgId, attachmentId, error: err });
    return res.status(500).json({ error: 'Failed to generate attachment URL' });
  }
});

export default router;
