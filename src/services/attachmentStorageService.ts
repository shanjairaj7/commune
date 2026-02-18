import { v2 as cloudinary } from 'cloudinary';
import { randomUUID } from 'crypto';
import logger from '../utils/logger';
import { getCollection } from '../db';
import { getOrgTierLimits, TierType } from '../config/rateLimits';
import type { Organization } from '../types/auth';

const CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME;
const CLOUDINARY_API_KEY = process.env.CLOUDINARY_API_KEY;
const CLOUDINARY_API_SECRET = process.env.CLOUDINARY_API_SECRET;
const CLOUDINARY_FOLDER = process.env.CLOUDINARY_FOLDER || 'commune-attachments';

const isCloudinaryConfigured = !!(
  CLOUDINARY_CLOUD_NAME &&
  CLOUDINARY_API_KEY &&
  CLOUDINARY_API_SECRET
);

if (isCloudinaryConfigured) {
  cloudinary.config({
    cloud_name: CLOUDINARY_CLOUD_NAME,
    api_key: CLOUDINARY_API_KEY,
    api_secret: CLOUDINARY_API_SECRET,
    secure: true,
  });
  logger.info('Cloudinary configured successfully');
} else {
  logger.warn('Cloudinary not configured - attachments will be stored in database as base64');
}

export interface UploadResult {
  storage_type: 'cloudinary' | 'database';
  cloudinary_url?: string;
  cloudinary_public_id?: string;
  content_base64?: string;
}

export class AttachmentStorageService {
  private static instance: AttachmentStorageService;

  private constructor() {}

  public static getInstance(): AttachmentStorageService {
    if (!AttachmentStorageService.instance) {
      AttachmentStorageService.instance = new AttachmentStorageService();
    }
    return AttachmentStorageService.instance;
  }

  public async uploadAttachment(
    buffer: Buffer,
    filename: string,
    mimeType: string,
    orgId?: string
  ): Promise<UploadResult> {
    if (!isCloudinaryConfigured) {
      logger.debug('Cloudinary not configured, storing in database', { filename });
      return {
        storage_type: 'database',
        content_base64: buffer.toString('base64'),
      };
    }

    try {
      const publicId = `${CLOUDINARY_FOLDER}/${orgId || 'default'}/${randomUUID()}-${filename}`;
      
      const uploadResult = await new Promise<any>((resolve, reject) => {
        const uploadStream = cloudinary.uploader.upload_stream(
          {
            public_id: publicId,
            resource_type: 'raw',
            type: 'private',
            access_mode: 'authenticated',
            folder: CLOUDINARY_FOLDER,
            context: {
              filename,
              mime_type: mimeType,
              org_id: orgId || 'default',
            },
          },
          (error, result) => {
            if (error) {
              reject(error);
            } else {
              resolve(result);
            }
          }
        );
        uploadStream.end(buffer);
      });

      logger.info('Attachment uploaded to Cloudinary', {
        filename,
        publicId: uploadResult.public_id,
        secureUrl: uploadResult.secure_url,
      });

      return {
        storage_type: 'cloudinary',
        cloudinary_url: uploadResult.secure_url,
        cloudinary_public_id: uploadResult.public_id,
      };
    } catch (error) {
      logger.error('Failed to upload to Cloudinary, falling back to database', {
        error,
        filename,
      });
      
      return {
        storage_type: 'database',
        content_base64: buffer.toString('base64'),
      };
    }
  }

  public async generateSignedUrl(
    cloudinaryPublicId: string,
    expiresIn: number = 3600
  ): Promise<string> {
    if (!isCloudinaryConfigured) {
      throw new Error('Cloudinary not configured');
    }

    try {
      const timestamp = Math.floor(Date.now() / 1000) + expiresIn;
      
      const signedUrl = cloudinary.url(cloudinaryPublicId, {
        resource_type: 'raw',
        type: 'private',
        sign_url: true,
        expires_at: timestamp,
        secure: true,
      });

      return signedUrl;
    } catch (error) {
      logger.error('Failed to generate signed URL', { error, cloudinaryPublicId });
      throw new Error('Failed to generate signed URL');
    }
  }

  public async deleteAttachment(cloudinaryPublicId: string): Promise<void> {
    if (!isCloudinaryConfigured) {
      logger.warn('Cloudinary not configured, cannot delete attachment');
      return;
    }

    try {
      await cloudinary.uploader.destroy(cloudinaryPublicId, {
        resource_type: 'raw',
        type: 'private',
      });
      
      logger.info('Attachment deleted from Cloudinary', { cloudinaryPublicId });
    } catch (error) {
      logger.error('Failed to delete attachment from Cloudinary', {
        error,
        cloudinaryPublicId,
      });
    }
  }

  public isCloudinaryConfigured(): boolean {
    return isCloudinaryConfigured;
  }

  /**
   * Check if an org has enough storage quota for the given bytes.
   * Returns { allowed, used, limit } or throws on DB error.
   */
  public async checkStorageQuota(orgId: string, bytesNeeded: number): Promise<{
    allowed: boolean;
    used: number;
    limit: number;
  }> {
    const orgs = await getCollection<Organization>('organizations');
    if (!orgs) return { allowed: true, used: 0, limit: Infinity };

    const org = await orgs.findOne({ id: orgId });
    if (!org) return { allowed: true, used: 0, limit: Infinity };

    const tier = (org.tier || 'free') as TierType;
    const limits = getOrgTierLimits(tier);
    const used = org.attachment_storage_used_bytes || 0;
    const limit = limits.attachmentStorageBytes;

    if (limit === Infinity) return { allowed: true, used, limit };

    return {
      allowed: used + bytesNeeded <= limit,
      used,
      limit,
    };
  }

  /**
   * Increment the org's attachment_storage_used_bytes after a successful upload.
   */
  public async trackStorageUsage(orgId: string, bytes: number): Promise<void> {
    if (!orgId || bytes <= 0) return;

    try {
      const orgs = await getCollection<Organization>('organizations');
      if (!orgs) return;

      await orgs.updateOne(
        { id: orgId },
        { $inc: { attachment_storage_used_bytes: bytes } as any }
      );
    } catch (error) {
      logger.error('Failed to track attachment storage usage', { orgId, bytes, error });
    }
  }

  /**
   * Decrement storage usage when an attachment is deleted.
   */
  public async releaseStorageUsage(orgId: string, bytes: number): Promise<void> {
    if (!orgId || bytes <= 0) return;

    try {
      const orgs = await getCollection<Organization>('organizations');
      if (!orgs) return;

      await orgs.updateOne(
        { id: orgId },
        { $inc: { attachment_storage_used_bytes: -bytes } as any }
      );
    } catch (error) {
      logger.error('Failed to release attachment storage usage', { orgId, bytes, error });
    }
  }
}

export default AttachmentStorageService;
