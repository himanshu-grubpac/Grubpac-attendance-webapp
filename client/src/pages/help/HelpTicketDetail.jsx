import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { formatISTDateTime } from '../../utils/datetime.js';
import { helpApi, getErrorMessage } from '../../services/api.js';
import { useToast } from '../../context/ToastContext.jsx';
import { usePageMetaContext } from '../../context/PageMetaContext.jsx';
import HelpStatusBadge from '../../components/HelpStatusBadge.jsx';
import BackLink from '../../components/BackLink.jsx';
import PageLoading from '../../components/PageLoading.jsx';
import EmptyState, { EMPTY_ICONS } from '../../components/EmptyState.jsx';
import SelectField from '../../components/SelectField.jsx';
import FieldError from '../../components/FieldError.jsx';

const STATUS_OPTIONS = [
  { value: 'open', label: 'Open' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'closed', label: 'Closed' },
];
import { useConfirmDialog } from '../../hooks/useConfirmDialog.jsx';

const MAX_COMMENT_ATTACHMENTS = 3;
const MAX_COMMENT_FILE_BYTES = 5 * 1024 * 1024;
const ALLOWED_COMMENT_FILE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
]);
const COMMENT_ACCEPT_ATTR = '.jpg,.jpeg,.png,.webp,.pdf,image/jpeg,image/png,image/webp,application/pdf';

function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function validateCommentFiles(files) {
  if (files.length > MAX_COMMENT_ATTACHMENTS) {
    return `You can attach up to ${MAX_COMMENT_ATTACHMENTS} files.`;
  }
  for (const file of files) {
    if (!ALLOWED_COMMENT_FILE_TYPES.has(file.type)) {
      return `"${file.name}" is not allowed. Use PDF, JPEG, PNG, or WebP.`;
    }
    if (file.size > MAX_COMMENT_FILE_BYTES) {
      return `"${file.name}" exceeds the 5 MB limit.`;
    }
  }
  return '';
}

function uploadFileToS3(uploadUrl, file, headers = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', uploadUrl);
    Object.entries(headers).forEach(([key, value]) => {
      xhr.setRequestHeader(key, value);
    });
    xhr.timeout = 120_000;
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
        return;
      }
      reject(new Error(`Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error('Upload failed.'));
    xhr.ontimeout = () => reject(new Error('Upload timed out.'));
    xhr.send(file);
  });
}

export default function HelpTicketDetail({ backTo, canUpdateStatus = false }) {
  const { showSuccess } = useToast();
  const { id } = useParams();
  const { requestConfirm, dialog: confirmDialog } = useConfirmDialog();
  const { setMeta } = usePageMetaContext();
  const fileInputRef = useRef(null);
  const [ticket, setTicket] = useState(null);
  const [comments, setComments] = useState([]);
  const [attachments, setAttachments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [commentBody, setCommentBody] = useState('');
  const [submittingComment, setSubmittingComment] = useState(false);
  const [updatingStatus, setUpdatingStatus] = useState(false);
  const [downloadingAttachmentId, setDownloadingAttachmentId] = useState('');
  const [statusValue, setStatusValue] = useState('open');
  const [selectedFiles, setSelectedFiles] = useState([]);
  const [attachmentError, setAttachmentError] = useState('');
  const [uploadingFiles, setUploadingFiles] = useState(false);

  async function loadTicket() {
    setLoading(true);
    setError('');
    try {
      const data = await helpApi.getTicket(id);
      setTicket(data.ticket);
      setComments(data.comments ?? []);
      setAttachments(data.attachments ?? []);
      setStatusValue(data.ticket?.status ?? 'open');
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadTicket();
  }, [id]);

  useEffect(() => {
    if (!ticket) return undefined;
    setMeta({
      title: ticket.title,
      subtitle: `${ticket.category} · ${ticket.priority} priority`,
      actions: <BackLink to={backTo} compact>Back</BackLink>,
    });
    return () => setMeta(null);
  }, [ticket, backTo, setMeta]);

  function addCommentFiles(incomingFiles) {
    if (uploadingFiles || incomingFiles.length === 0) return;

    const merged = [...selectedFiles];
    let nextError = '';

    for (const file of incomingFiles) {
      if (merged.length >= MAX_COMMENT_ATTACHMENTS) {
        nextError = `You can attach up to ${MAX_COMMENT_ATTACHMENTS} files.`;
        break;
      }
      if (merged.some((existing) => existing.name === file.name && existing.size === file.size)) {
        continue;
      }

      const candidate = [...merged, file];
      const validationError = validateCommentFiles(candidate);
      if (validationError) {
        nextError = validationError;
        if (validationError.includes('up to')) break;
        continue;
      }

      merged.push(file);
    }

    setSelectedFiles(merged);
    setAttachmentError(nextError);
  }

  function handleCommentFilesChange(event) {
    addCommentFiles(Array.from(event.target.files ?? []));
    event.target.value = '';
  }

  function removeCommentFile(index) {
    if (uploadingFiles) return;
    setSelectedFiles((prev) => prev.filter((_, itemIndex) => itemIndex !== index));
    setAttachmentError('');
  }

  async function handleCommentSubmit(event) {
    event.preventDefault();
    if (!commentBody.trim() && selectedFiles.length === 0) return;
    setSubmittingComment(true);
    setError('');
    setAttachmentError('');
    setUploadingFiles(true);

    try {
      const commentResult = await helpApi.addComment(id, { body: commentBody.trim() });
      const commentId = commentResult.comment?.id;

      if (commentId && selectedFiles.length > 0) {
        let uploadFailed = false;
        for (const file of selectedFiles) {
          try {
            const presign = await helpApi.presignCommentAttachment(id, commentId, {
              fileName: file.name,
              mimeType: file.type,
              sizeBytes: file.size,
            });

            await uploadFileToS3(presign.uploadUrl, file, presign.uploadHeaders ?? {});

            await helpApi.confirmCommentAttachment(id, commentId, presign.attachment.id);
          } catch (uploadErr) {
            uploadFailed = true;
          }
        }

        if (uploadFailed) {
          await helpApi.deleteComment(id, commentId);
          setCommentBody('');
          setSelectedFiles([]);
          setAttachmentError('');
          setError('File upload failed. Comment was not saved.');
          await loadTicket();
          return;
        } else {
          showSuccess('Comment added with attachments.');
        }
      } else {
        showSuccess('Comment added.');
      }

      setCommentBody('');
      setSelectedFiles([]);
      setAttachmentError('');
      await loadTicket();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSubmittingComment(false);
      setUploadingFiles(false);
    }
  }

  async function handleStatusUpdate(event) {
    event.preventDefault();

    if (statusValue === 'resolved' || statusValue === 'closed') {
      await requestConfirm({
        title: statusValue === 'closed' ? 'Close ticket?' : 'Mark ticket resolved?',
        message:
          statusValue === 'closed'
            ? 'Close this ticket? Reopening later may require another status change.'
            : 'Mark this ticket as resolved?',
        confirmLabel: statusValue === 'closed' ? 'Close ticket' : 'Mark resolved',
        variant: 'danger',
        onConfirm: async () => {
          setUpdatingStatus(true);
          setError('');
          try {
            await helpApi.updateTicketStatus(id, { status: statusValue });
            showSuccess('Ticket status updated.');
            await loadTicket();
          } finally {
            setUpdatingStatus(false);
          }
        },
      });
      return;
    }

    setUpdatingStatus(true);
    setError('');
    try {
      await helpApi.updateTicketStatus(id, { status: statusValue });
      showSuccess('Ticket status updated.');
      await loadTicket();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setUpdatingStatus(false);
    }
  }

  async function handleAttachmentDownload(attachmentId) {
    setDownloadingAttachmentId(attachmentId);
    setError('');
    try {
      const data = await helpApi.getAttachmentDownloadUrl(id, attachmentId);
      window.open(data.downloadUrl, '_blank', 'noopener,noreferrer');
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setDownloadingAttachmentId('');
    }
  }

  if (loading) {
    return (
      <div className="page">
        <PageLoading text="Loading ticket…" />
      </div>
    );
  }

  if (!ticket) {
    return (
      <div className="page">
        <div className="alert alert--error">{error || 'Ticket not found.'}</div>
        <BackLink to={backTo}>Back</BackLink>
      </div>
    );
  }

  return (
    <div className="page">
      {error ? (
        <div className="page-alerts">
          <div className="alert alert--error">{error}</div>
        </div>
      ) : null}

      <div className="card help-ticket-hero">
        <div className="help-ticket-hero__status">
          <HelpStatusBadge status={ticket.status} />
          <span className="muted small">
            {ticket.category} · {ticket.priority} priority
          </span>
        </div>
        <p className="help-ticket-hero__body">{ticket.description}</p>
        <dl className="detail-list detail-list--grid">
          <div>
            <dt>Created by</dt>
            <dd>{ticket.createdByName ?? '—'}</dd>
          </div>
          <div>
            <dt>Created</dt>
            <dd>{formatISTDateTime(ticket.createdAt)}</dd>
          </div>
          {ticket.assignedToName && (
            <div>
              <dt>Assigned to</dt>
              <dd>{ticket.assignedToName}</dd>
            </div>
          )}
        </dl>
      </div>

      {attachments.length > 0 && (
        <div className="card">
          <p className="card__section-title">Attachments</p>
          <ul className="comment-list">
            {attachments.map((item) => (
              <li key={item.id} className="comment-list__item">
                <div className="comment-list__meta">
                  <strong>{item.fileName}</strong>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    disabled={downloadingAttachmentId === item.id}
                    onClick={() => handleAttachmentDownload(item.id)}
                  >
                    {downloadingAttachmentId === item.id ? 'Preparing…' : 'Download'}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {canUpdateStatus && (
        <div className="card">
        <p className="card__section-title">Update status</p>
        <form className="toolbar-row" onSubmit={handleStatusUpdate}>
            <label className="field-inline form-field--sm">
              <span className="label">Status</span>
              <SelectField
                value={statusValue}
                onChange={setStatusValue}
                options={STATUS_OPTIONS}
                aria-label="Status"
              />
            </label>
            <button type="submit" className="btn btn-primary" disabled={updatingStatus}>
              {updatingStatus ? 'Saving…' : 'Save status'}
            </button>
          </form>
        </div>
      )}

      <div className="card">
        <p className="card__section-title">Comments</p>
        {comments.length === 0 ? (
          <EmptyState
            compact
            icon={EMPTY_ICONS.inbox}
            title="No comments yet"
            description="Be the first to add an update on this ticket."
          />
        ) : (
          <ul className="comment-list">
            {comments.map((item) => (
              <li key={item.id} className="comment-list__item">
                <div className="comment-list__meta">
                  <strong>{item.userName ?? 'User'}</strong>
                  <span className="muted small">{formatISTDateTime(item.createdAt)}</span>
                </div>
                <p>{item.body}</p>
                {item.attachments && item.attachments.length > 0 && (
                  <ul className="comment-attachments">
                    {item.attachments.map((att) => (
                      <li key={att.id} className="comment-attachments__item">
                        <span className="comment-attachments__name">{att.fileName}</span>
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          disabled={downloadingAttachmentId === att.id}
                          onClick={() => handleAttachmentDownload(att.id)}
                        >
                          {downloadingAttachmentId === att.id ? 'Preparing…' : 'Download'}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}

        <form className="form-grid" onSubmit={handleCommentSubmit}>
          <label className="field form-grid__full">
            <span className="label">Add comment</span>
            <textarea
              value={commentBody}
              onChange={(event) => setCommentBody(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
              rows={3}
              maxLength={5000}
              placeholder="Write a reply…"
            />
          </label>

          <div className="field form-grid__full">
            <span className="label">Attachments (optional)</span>
            <div className="comment-upload">
              <input
                ref={fileInputRef}
                className="comment-upload__file-input"
                type="file"
                accept={COMMENT_ACCEPT_ATTR}
                multiple
                onChange={handleCommentFilesChange}
                disabled={uploadingFiles || selectedFiles.length >= MAX_COMMENT_ATTACHMENTS}
                aria-hidden="true"
                tabIndex={-1}
              />
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploadingFiles || selectedFiles.length >= MAX_COMMENT_ATTACHMENTS}
              >
                {selectedFiles.length >= MAX_COMMENT_ATTACHMENTS ? 'Max files added' : 'Add files'}
              </button>
              <span className="muted small">
                PDF, JPEG, PNG, or WebP · Up to {MAX_COMMENT_ATTACHMENTS} files · 5 MB each
              </span>

              {selectedFiles.length > 0 && (
                <ul className="comment-upload__list" aria-label="Selected attachments">
                  {selectedFiles.map((file, index) => (
                    <li key={`${file.name}-${file.size}-${index}`} className="comment-upload__item">
                      <span className="comment-upload__name">{file.name}</span>
                      <span className="muted small">{formatFileSize(file.size)}</span>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={() => removeCommentFile(index)}
                        disabled={uploadingFiles}
                      >
                        Remove
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <FieldError message={attachmentError} />
            </div>
          </div>

          <div className="form-actions">
            <button type="submit" className="btn btn-primary" disabled={submittingComment || uploadingFiles}>
              {submittingComment ? 'Posting…' : 'Post comment'}
            </button>
          </div>
        </form>
      </div>

      {confirmDialog}
    </div>
  );
}
