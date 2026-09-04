import { randomUUID } from 'crypto';
import mongoose from 'mongoose';
import {
  HeadObjectCommand,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectsCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { HelpAttachment, HELP_ATTACHMENT_POPULATE } from '../models/HelpAttachment.js';
import { HelpTicket, HELP_TICKET_POPULATE } from '../models/HelpTicket.js';
import { HelpComment, HELP_COMMENT_POPULATE } from '../models/HelpComment.js';
import { canViewTicket } from './helpService.js';
import { auditLog } from '../utils/auditLog.js';

/*
 * S3 bucket CORS (configure manually on existing buckets — not managed by SAM):
 * [
 *   {
 *     "AllowedHeaders": ["*"],
 *     "AllowedMethods": ["PUT", "GET", "HEAD"],
 *     "AllowedOrigins": [
 *       "https://d24p2zn8763d4h.cloudfront.net",
 *       "https://d1qk2thz664f5x.cloudfront.net",
 *       "http://localhost:5173"
 *     ],
 *     "ExposeHeaders": ["ETag"],
 *     "MaxAgeSeconds": 3600
 *   }
 * ]
 */

export const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
]);

export const MAX_BYTES = Number(process.env.UPLOAD_MAX_BYTES ?? 5_242_880);
export const MAX_FILES_PER_TICKET = 5;
export const MAX_FILES_PER_COMMENT = 3;
const UPLOADS_PREFIX = process.env.UPLOADS_PREFIX ?? 'help-tickets';
const PRESIGN_EXPIRES_SECONDS = 900;
const DOWNLOAD_EXPIRES_SECONDS = 300;

function throwError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  throw error;
}

export function getUploadsBucket() {
  const bucket = process.env.UPLOADS_BUCKET;
  if (!bucket) {
    throwError('File uploads are not configured.', 503);
  }
  return bucket;
}

let _s3Client = null;
/**
 * S3 client for help-ticket attachments.
 * - Static keys (local dev / explicit env) are honored, including the session
 *   token when present (temporary credentials).
 * - Otherwise the AWS SDK default credential chain is used, so the Lambda
 *   execution role (temporary container credentials) just works — no manual
 *   keys required on staging/prod.
 */
export function getS3Client() {
  if (_s3Client) return _s3Client;
  const region = process.env.AWS_REGION ?? 'ap-south-1';
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  const sessionToken = process.env.AWS_SESSION_TOKEN;
  if (accessKeyId && secretAccessKey) {
    _s3Client = new S3Client({
      region,
      credentials: {
        accessKeyId,
        secretAccessKey,
        ...(sessionToken ? { sessionToken } : {}),
      },
    });
  } else {
    _s3Client = new S3Client({ region });
  }
  return _s3Client;
}
/** Test-only hook to drop the cached client between credential scenarios. */
export function resetS3ClientForTests() {
  _s3Client = null;
}

export function sanitizeFilename(fileName) {
  const base = fileName.replace(/\\/g, '/').split('/').pop() ?? 'file';
  const sanitized = base
    .replace(/[^\w.\-()+\s]/g, '_')
    .replace(/\.{2,}/g, '.')
    .trim()
    .slice(0, 200);
  return sanitized || 'file';
}

export function isAllowedMimeType(mimeType) {
  return ALLOWED_MIME_TYPES.has(mimeType);
}

export function buildS3Key(ticketId, fileName, prefix = UPLOADS_PREFIX) {
  const uuid = randomUUID();
  const safeName = sanitizeFilename(fileName);
  return `${prefix}/${ticketId}/${uuid}-${safeName}`;
}

function getCreatorId(ticket) {
  return ticket.createdBy?._id?.toString() ?? ticket.createdBy?.toString?.() ?? null;
}

function canUploadToTicket(actor, ticket) {
  return getCreatorId(ticket) === actor._id.toString();
}

async function loadTicket(ticketId) {
  if (!mongoose.isValidObjectId(ticketId)) {
    throwError('Help ticket not found.', 404);
  }

  const ticket = await HelpTicket.findById(ticketId).populate(HELP_TICKET_POPULATE);
  if (!ticket) {
    throwError('Help ticket not found.', 404);
  }
  return ticket;
}

async function countActiveAttachments(ticketId) {
  return HelpAttachment.countDocuments({
    ticketId,
    status: { $in: ['pending', 'confirmed'] },
  });
}

async function loadAttachment(ticketId, attachmentId) {
  if (!mongoose.isValidObjectId(attachmentId)) {
    throwError('Attachment not found.', 404);
  }

  const attachment = await HelpAttachment.findOne({
    _id: attachmentId,
    ticketId,
    status: { $ne: 'deleted' },
  }).populate(HELP_ATTACHMENT_POPULATE);

  if (!attachment) {
    throwError('Attachment not found.', 404);
  }
  return attachment;
}

export async function listAttachmentsForTicket(ticketId) {
  const attachments = await HelpAttachment.find({
    ticketId,
    status: 'confirmed',
  })
    .populate(HELP_ATTACHMENT_POPULATE)
    .sort({ createdAt: 1 });

  return attachments.map((item) => item.toSafeJSON());
}

export async function presignUpload(actor, ticketId, permissions, payload) {
  const ticket = await loadTicket(ticketId);
  if (!canViewTicket(actor, ticket, permissions)) {
    throwError('You do not have permission to view this ticket.', 403);
  }
  if (!canUploadToTicket(actor, ticket)) {
    throwError('You can only attach files to your own tickets.', 403);
  }

  if (!isAllowedMimeType(payload.mimeType)) {
    throwError('File type is not allowed. Use JPEG, PNG, WebP, or PDF.');
  }
  if (payload.sizeBytes > MAX_BYTES) {
    throwError(`File exceeds the ${Math.floor(MAX_BYTES / (1024 * 1024))} MB limit.`);
  }

  const activeCount = await countActiveAttachments(ticket._id);
  if (activeCount >= MAX_FILES_PER_TICKET) {
    throwError(`Maximum ${MAX_FILES_PER_TICKET} attachments per ticket.`);
  }

  const bucket = getUploadsBucket();
  const s3Key = buildS3Key(ticket._id.toString(), payload.fileName);

  const attachment = await HelpAttachment.create({
    ticketId: ticket._id,
    uploadedBy: actor._id,
    fileName: sanitizeFilename(payload.fileName),
    mimeType: payload.mimeType,
    sizeBytes: payload.sizeBytes,
    s3Key,
    status: 'pending',
  });

  const s3Client = getS3Client();
  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: s3Key,
    ContentType: payload.mimeType,
    ContentLength: payload.sizeBytes,
  });
  const uploadUrl = await getSignedUrl(s3Client, command, {
    expiresIn: PRESIGN_EXPIRES_SECONDS,
  });

  auditLog('help_attachment_presigned', {
    userId: actor._id.toString(),
    ticketId: ticket._id.toString(),
    attachmentId: attachment._id.toString(),
    fileName: attachment.fileName,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
  });

  return {
    attachment: attachment.toSafeJSON(),
    uploadUrl,
    uploadHeaders: {
      'Content-Type': payload.mimeType,
    },
    expiresIn: PRESIGN_EXPIRES_SECONDS,
  };
}

export async function confirmUpload(actor, ticketId, attachmentId, permissions) {
  const ticket = await loadTicket(ticketId);
  if (!canViewTicket(actor, ticket, permissions)) {
    throwError('You do not have permission to view this ticket.', 403);
  }

  const attachment = await loadAttachment(ticketId, attachmentId);
  if (attachment.status !== 'pending') {
    throwError('Attachment is not awaiting confirmation.');
  }
  if (attachment.uploadedBy?._id?.toString() !== actor._id.toString() &&
      attachment.uploadedBy?.toString?.() !== actor._id.toString()) {
    throwError('You can only confirm attachments you uploaded.', 403);
  }

  const bucket = getUploadsBucket();
  const s3Client = getS3Client();

  let headResult;
  try {
    headResult = await s3Client.send(
      new HeadObjectCommand({
        Bucket: bucket,
        Key: attachment.s3Key,
      }),
    );
  } catch (s3Err) {
    console.error('[help-attachment] HeadObject failed:', s3Err?.message ?? s3Err);
    throwError('Uploaded file was not found. Please upload again.', 404);
  }

  const actualSize = Number(headResult.ContentLength ?? 0);
  if (actualSize !== attachment.sizeBytes) {
    throwError('Uploaded file size does not match the declared size.');
  }

  const actualMime = headResult.ContentType ?? '';
  if (actualMime && actualMime !== attachment.mimeType) {
    throwError('Uploaded file type does not match the declared type.');
  }
  if (!actualMime) {
    console.warn(`[help-attachment] S3 returned empty ContentType for ${attachment.s3Key}`);
  }

  attachment.status = 'confirmed';
  await attachment.save();
  await attachment.populate(HELP_ATTACHMENT_POPULATE);

  auditLog('help_attachment_confirmed', {
    userId: actor._id.toString(),
    ticketId: ticket._id.toString(),
    attachmentId: attachment._id.toString(),
    fileName: attachment.fileName,
    sizeBytes: actualSize,
  });

  return attachment.toSafeJSON();
}

export async function getDownloadUrl(actor, ticketId, attachmentId, permissions) {
  const ticket = await loadTicket(ticketId);
  if (!canViewTicket(actor, ticket, permissions)) {
    throwError('You do not have permission to view this ticket.', 403);
  }

  const attachment = await loadAttachment(ticketId, attachmentId);
  if (attachment.status !== 'confirmed') {
    throwError('Attachment is not available for download.', 404);
  }

  const bucket = getUploadsBucket();
  const s3Client = getS3Client();

  try {
    await s3Client.send(
      new HeadObjectCommand({
        Bucket: bucket,
        Key: attachment.s3Key,
      }),
    );
  } catch (s3Err) {
    console.error('[help-attachment] Download HEAD check failed:', s3Err?.message ?? s3Err);
    attachment.status = 'deleted';
    await attachment.save();
    throwError('Attachment file not found on server.', 404);
  }

  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: attachment.s3Key,
    ResponseContentDisposition: `attachment; filename="${attachment.fileName.replace(/[^a-zA-Z0-9._-]/g, '_')}"`,
    ResponseContentType: attachment.mimeType,
  });
  const downloadUrl = await getSignedUrl(s3Client, command, {
    expiresIn: DOWNLOAD_EXPIRES_SECONDS,
  });

  auditLog('help_attachment_download', {
    userId: actor._id.toString(),
    ticketId: ticket._id.toString(),
    attachmentId: attachment._id.toString(),
    fileName: attachment.fileName,
  });

  return {
    downloadUrl,
    fileName: attachment.fileName,
    mimeType: attachment.mimeType,
    expiresIn: DOWNLOAD_EXPIRES_SECONDS,
  };
}

async function loadComment(ticketId, commentId) {
  if (!mongoose.isValidObjectId(commentId)) {
    throwError('Comment not found.', 404);
  }

  const comment = await HelpComment.findOne({
    _id: commentId,
    ticketId,
  }).populate(HELP_COMMENT_POPULATE);

  if (!comment) {
    throwError('Comment not found.', 404);
  }
  return comment;
}

async function countActiveCommentAttachments(commentId) {
  return HelpAttachment.countDocuments({
    commentId,
    status: { $in: ['pending', 'confirmed'] },
  });
}

export async function presignCommentUpload(actor, ticketId, commentId, permissions, payload) {
  const ticket = await loadTicket(ticketId);
  if (!canViewTicket(actor, ticket, permissions)) {
    throwError('You do not have permission to view this ticket.', 403);
  }

  const comment = await loadComment(ticketId, commentId);

  // Only the comment author or the ticket creator may attach files to a comment.
  const actorId = actor._id.toString();
  const commentAuthorId = comment.userId?._id?.toString() ?? comment.userId?.toString?.() ?? null;
  if (getCreatorId(ticket) !== actorId && commentAuthorId !== actorId) {
    throwError('You can only attach files to your own comments.', 403);
  }

  if (!isAllowedMimeType(payload.mimeType)) {
    throwError('File type is not allowed. Use JPEG, PNG, WebP, or PDF.');
  }
  if (payload.sizeBytes > MAX_BYTES) {
    throwError(`File exceeds the ${Math.floor(MAX_BYTES / (1024 * 1024))} MB limit.`);
  }

  const activeCount = await countActiveCommentAttachments(comment._id);
  if (activeCount >= MAX_FILES_PER_COMMENT) {
    throwError(`Maximum ${MAX_FILES_PER_COMMENT} attachments per comment.`);
  }

  const bucket = getUploadsBucket();
  const s3Key = buildS3Key(ticket._id.toString(), payload.fileName, `${UPLOADS_PREFIX}/${ticket._id.toString()}/comments/${comment._id.toString()}`);

  const attachment = await HelpAttachment.create({
    ticketId: ticket._id,
    commentId: comment._id,
    uploadedBy: actor._id,
    fileName: sanitizeFilename(payload.fileName),
    mimeType: payload.mimeType,
    sizeBytes: payload.sizeBytes,
    s3Key,
    status: 'pending',
  });

  const s3Client = getS3Client();
  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: s3Key,
    ContentType: payload.mimeType,
    ContentLength: payload.sizeBytes,
  });
  const uploadUrl = await getSignedUrl(s3Client, command, {
    expiresIn: PRESIGN_EXPIRES_SECONDS,
  });

  auditLog('help_comment_attachment_presigned', {
    userId: actor._id.toString(),
    ticketId: ticket._id.toString(),
    commentId: comment._id.toString(),
    attachmentId: attachment._id.toString(),
    fileName: attachment.fileName,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
  });

  return {
    attachment: attachment.toSafeJSON(),
    uploadUrl,
    uploadHeaders: {
      'Content-Type': payload.mimeType,
    },
    expiresIn: PRESIGN_EXPIRES_SECONDS,
  };
}

export async function confirmCommentUpload(actor, ticketId, commentId, attachmentId, permissions) {
  const ticket = await loadTicket(ticketId);
  if (!canViewTicket(actor, ticket, permissions)) {
    throwError('You do not have permission to view this ticket.', 403);
  }

  await loadComment(ticketId, commentId);

  const attachment = await HelpAttachment.findOne({
    _id: attachmentId,
    ticketId,
    commentId,
    status: 'pending',
  }).populate(HELP_ATTACHMENT_POPULATE);

  if (!attachment) {
    throwError('Attachment not found.', 404);
  }

  if (attachment.uploadedBy?._id?.toString() !== actor._id.toString() &&
      attachment.uploadedBy?.toString?.() !== actor._id.toString()) {
    throwError('You can only confirm attachments you uploaded.', 403);
  }

  const bucket = getUploadsBucket();
  const s3Client = getS3Client();

  let headResult;
  try {
    headResult = await s3Client.send(
      new HeadObjectCommand({
        Bucket: bucket,
        Key: attachment.s3Key,
      }),
    );
  } catch (s3Err) {
    console.error('[help-attachment] HeadObject failed:', s3Err?.message ?? s3Err);
    throwError('Uploaded file was not found. Please upload again.', 404);
  }

  const actualSize = Number(headResult.ContentLength ?? 0);
  if (actualSize !== attachment.sizeBytes) {
    throwError('Uploaded file size does not match the declared size.');
  }

  const actualMime = headResult.ContentType ?? '';
  if (actualMime && actualMime !== attachment.mimeType) {
    throwError('Uploaded file type does not match the declared type.');
  }
  if (!actualMime) {
    console.warn(`[help-attachment] S3 returned empty ContentType for ${attachment.s3Key}`);
  }

  attachment.status = 'confirmed';
  await attachment.save();
  await attachment.populate(HELP_ATTACHMENT_POPULATE);

  auditLog('help_comment_attachment_confirmed', {
    userId: actor._id.toString(),
    ticketId: ticket._id.toString(),
    commentId: commentId,
    attachmentId: attachment._id.toString(),
    fileName: attachment.fileName,
    sizeBytes: actualSize,
  });

  return attachment.toSafeJSON();
}

export async function listAttachmentsForComment(commentId) {
  const attachments = await HelpAttachment.find({
    commentId,
    status: 'confirmed',
  })
    .populate(HELP_ATTACHMENT_POPULATE)
    .sort({ createdAt: 1 });

  return attachments.map((item) => item.toSafeJSON());
}

const STALE_PENDING_MAX_AGE_MS = 60 * 60 * 1000;

export async function deleteS3Objects(s3Keys) {
  if (!s3Keys || s3Keys.length === 0) return;
  try {
    const bucket = getUploadsBucket();
    const s3Client = getS3Client();
    const objects = s3Keys.map((Key) => ({ Key }));
    await s3Client.send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: { Objects: objects },
      }),
    );
  } catch (err) {
    console.error('[help-attachment] S3 batch delete failed:', err?.message ?? err);
  }
}

export async function cleanupStalePendingAttachments() {
  const cutoff = new Date(Date.now() - STALE_PENDING_MAX_AGE_MS);
  const stale = await HelpAttachment.find({
    status: 'pending',
    createdAt: { $lt: cutoff },
  }).select('s3Key');

  if (stale.length === 0) return { cleaned: 0 };

  console.log(`[help-attachment] Cleaning up ${stale.length} stale pending attachment(s)`);
  await deleteS3Objects(stale.map((a) => a.s3Key));
  await HelpAttachment.deleteMany({ _id: { $in: stale.map((a) => a._id) } });
  return { cleaned: stale.length };
}
