/**
 * Submit-failure UX: page-level error alerts render at the top of long forms
 * while the user stares at the submit button at the bottom. Setting the
 * message alone leaves failures effectively invisible — always bring the
 * alert into view and focus it (it carries role="alert").
 */
export function showFormError({ setError, setFieldErrors, alertRef, message, fieldErrors = {} }) {
  if (setFieldErrors && fieldErrors && Object.keys(fieldErrors).length > 0) {
    setFieldErrors(fieldErrors);
  }
  if (setError) {
    setError(message);
  }
  const node = alertRef?.current ?? null;
  if (!node) return;
  if (typeof node.scrollIntoView === 'function') {
    node.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  if (typeof node.focus === 'function') {
    node.focus({ preventScroll: true });
  }
}

/**
 * Client mirror of the server's medical-certificate rule
 * (validateLeaveRequestInput): SL-type leave longer than the policy threshold
 * without a document URL is always rejected server-side. Returns the blocking
 * message, or '' when the rule does not apply (WFH mode, half-day, no
 * threshold configured, document attached, or no current day-preview to
 * measure against — in the last case the server remains the source of truth).
 */
export function buildDocCertificateError({
  isWfhMode = false,
  leaveTypeCode = '',
  threshold = null,
  requestedDays = 0,
  previewIsCurrent = false,
  halfDay = '',
  hasDocument = false,
} = {}) {
  if (isWfhMode) return '';
  if (halfDay) return '';
  if (hasDocument) return '';
  const limit = Number(threshold);
  if (!Number.isFinite(limit) || limit <= 0) return '';
  if (!previewIsCurrent) return '';
  if (Number(requestedDays) <= limit) return '';
  const code = String(leaveTypeCode || 'SL').toUpperCase();
  return (
    `Medical certificate is required for ${code} leave exceeding ` +
    `${limit} consecutive working day(s). Attach the certificate URL before submitting.`
  );
}
