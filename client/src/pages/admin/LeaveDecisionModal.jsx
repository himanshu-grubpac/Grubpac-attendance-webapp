import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useEscapeKey } from '../../hooks/useEscapeKey.js';

export default function LeaveDecisionModal({
  open,
  item,
  action = 'approve',
  initialComment = '',
  busy = false,
  error = '',
  onApprove,
  onReject,
  onCancel,
  onCommentChange,
}) {
  const titleId = useId();
  const descId = useId();
  const dialogRef = useRef(null);
  const approveRef = useRef(null);
  const rejectRef = useRef(null);
  const cancelRef = useRef(null);
  const commentRef = useRef(null);
  const previouslyFocused = useRef(null);

  const remarkEmpty = !initialComment.trim();
  const isCancelMode = action === 'cancel';
  // Dismiss never takes action: Escape / backdrop / Cancel only close the modal.
  // Falls back to onReject so older callers that used it as "close" keep working.
  const handleDismiss = onCancel ?? onReject;

  useEscapeKey(open && !busy, handleDismiss);

  useEffect(() => {
    if (!open) return undefined;

    previouslyFocused.current = document.activeElement;
    commentRef.current?.focus();

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    function handleKeyDown(event) {
      if (event.key !== 'Tab' || busy) return;
      const focusables = [commentRef.current, cancelRef.current, rejectRef.current, approveRef.current].filter(Boolean);
      if (focusables.length === 0) return;

      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;

      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    }

    const dialogNode = dialogRef.current;
    dialogNode?.addEventListener('keydown', handleKeyDown);

    return () => {
      dialogNode?.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = previousOverflow;
      if (previouslyFocused.current instanceof HTMLElement) {
        previouslyFocused.current.focus();
      }
    };
  }, [open, busy]);

  if (!open || !item) return null;

  const leaveType = item.leaveTypeCode && item.leaveTypeName
    ? `${item.leaveTypeCode} — ${item.leaveTypeName}`
    : item.leaveTypeCode || item.leaveTypeName || 'Leave';

  const start = item.startDate ? new Date(item.startDate).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' }) : '—';
  const end = item.endDate ? new Date(item.endDate).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' }) : '—';
  const dateText = start === end ? start : `${start} – ${end}`;
  const halfDay = item.halfDay === 'am' ? ' · Morning half-day' : item.halfDay === 'pm' ? ' · Afternoon half-day' : '';

  return createPortal(
    <div
      className="confirm-dialog-backdrop"
      role="presentation"
      onClick={busy ? undefined : handleDismiss}
    >
      <div
        ref={dialogRef}
        className="confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id={titleId} className="confirm-dialog__title">
          {isCancelMode ? 'Cancel approved leave' : 'Leave request decision'}
        </h2>

        <div id={descId} className="confirm-dialog__message" style={{ padding: 0 }}>
          <dl style={{ margin: '0 0 16px', fontSize: '14px', lineHeight: '1.6' }}>
            <div style={{ marginBottom: '6px' }}>
              <dt style={{ fontWeight: 600, display: 'inline' }}>Employee: </dt>
              <dd style={{ display: 'inline', margin: 0 }}>{item.userName || '—'}</dd>
            </div>
            <div style={{ marginBottom: '6px' }}>
              <dt style={{ fontWeight: 600, display: 'inline' }}>Leave type: </dt>
              <dd style={{ display: 'inline', margin: 0 }}>{leaveType}</dd>
            </div>
            <div style={{ marginBottom: '6px' }}>
              <dt style={{ fontWeight: 600, display: 'inline' }}>Date: </dt>
              <dd style={{ display: 'inline', margin: 0 }}>{dateText}{halfDay}</dd>
            </div>
            <div style={{ marginBottom: '6px' }}>
              <dt style={{ fontWeight: 600, display: 'inline' }}>Duration: </dt>
              <dd style={{ display: 'inline', margin: 0 }}>
                {Number(item.days) === 1 ? '1 day' : `${item.days} days`}
              </dd>
            </div>
            {item.reason ? (
              <div>
                <dt style={{ fontWeight: 600, display: 'inline' }}>Reason: </dt>
                <dd style={{ display: 'inline', margin: 0 }}>{item.reason}</dd>
              </div>
            ) : null}
          </dl>
        </div>

        {error ? (
          <div className="alert alert--error confirm-dialog__error" role="alert">
            {error}
          </div>
        ) : null}

        <label className="field" style={{ marginBottom: '16px' }}>
          <span className="label">Remarks <span style={{ color: '#dc2626' }}>*</span></span>
          <textarea
            ref={commentRef}
            className="approval-row__comment-input"
            value={initialComment}
            onChange={(event) => onCommentChange?.(event.target.value)}
            placeholder="Enter a remark for the employee"
            disabled={busy}
            maxLength={500}
            rows={3}
            style={{ width: '100%', resize: 'vertical', padding: '8px 12px', border: '1px solid #d1d5db', borderRadius: '6px', fontSize: '14px', fontFamily: 'inherit' }}
          />
        </label>

        <div className="confirm-dialog__actions">
          <button
            ref={cancelRef}
            type="button"
            className="btn"
            onClick={handleDismiss}
            disabled={busy}
          >
            Cancel
          </button>
          {isCancelMode ? null : (
            <button
              ref={rejectRef}
              type="button"
              className="btn btn-danger"
              onClick={onReject}
              disabled={busy || remarkEmpty}
            >
              Reject
            </button>
          )}
          <button
            ref={approveRef}
            type="button"
            className={`btn ${isCancelMode ? 'btn-danger' : 'btn-primary'}`}
            onClick={onApprove}
            disabled={busy || remarkEmpty}
          >
            {busy ? 'Submitting…' : (isCancelMode ? 'Cancel leave' : 'Approve')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
