import { useEffect, useState } from 'react';
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

const STATUS_OPTIONS = [
  { value: 'open', label: 'Open' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'closed', label: 'Closed' },
];
import { useConfirmDialog } from '../../hooks/useConfirmDialog.jsx';

export default function HelpTicketDetail({ backTo, canUpdateStatus = false }) {
  const { showSuccess } = useToast();
  const { id } = useParams();
  const { requestConfirm, dialog: confirmDialog } = useConfirmDialog();
  const { setMeta } = usePageMetaContext();
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

  async function handleCommentSubmit(event) {
    event.preventDefault();
    if (!commentBody.trim()) return;
    setSubmittingComment(true);
    setError('');
    try {
      await helpApi.addComment(id, { body: commentBody.trim() });
      setCommentBody('');
      showSuccess('Comment added.');
      await loadTicket();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSubmittingComment(false);
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
          <div className="form-actions">
            <button type="submit" className="btn btn-primary" disabled={submittingComment}>
              {submittingComment ? 'Posting…' : 'Post comment'}
            </button>
          </div>
        </form>
      </div>

      {confirmDialog}
    </div>
  );
}
