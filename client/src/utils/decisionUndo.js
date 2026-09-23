/** Fallback windows when the server omits decisionUndoExpiresAt (legacy rows). */
export const SUBMIT_UNDO_FALLBACK_MS = 10000;
export const DECISION_UNDO_FALLBACK_MS = 15000;
export const ATTENDANCE_UNDO_FALLBACK_MS = 15000;

/** Parse API `decisionUndoExpiresAt` (ISO) to epoch ms, or null. */
export function parseDecisionUndoExpiresAt(raw) {
  const ms = Date.parse(raw ?? '');
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Resolve the server-authoritative undo deadline for a request row.
 * Never uses notifyAfter — only decisionUndoExpiresAt or legacy decidedAt + window.
 *
 * @param {object|null|undefined} request
 * @param {{ pendingField?: string, fallbackWindowMs?: number }} [options]
 * @returns {number|null} epoch ms
 */
export function resolveDecisionUndoExpiresAt(
  request,
  {
    pendingField = 'pendingDecision',
    fallbackWindowMs = DECISION_UNDO_FALLBACK_MS,
  } = {},
) {
  const serverExpiry = parseDecisionUndoExpiresAt(request?.decisionUndoExpiresAt);
  if (serverExpiry != null) return serverExpiry;
  const pending = request?.[pendingField];
  if (pending && request?.decidedAt) {
    const decidedAt = Date.parse(request.decidedAt);
    if (Number.isFinite(decidedAt)) return decidedAt + fallbackWindowMs;
  }
  return null;
}

/** Remaining undo time in ms; uses fallback when expiry is unknown. */
export function undoRemainingMs(expiresAtMs, { fallbackMs = 0 } = {}) {
  if (Number.isFinite(expiresAtMs)) return Math.max(0, expiresAtMs - Date.now());
  return fallbackMs;
}

/** Remaining ms for a freshly submitted/edited leave or comp-off row. */
export function submitUndoRemainingMs(request, fallbackMs = SUBMIT_UNDO_FALLBACK_MS) {
  return undoRemainingMs(parseDecisionUndoExpiresAt(request?.decisionUndoExpiresAt), { fallbackMs });
}

/** Remaining ms while a staged admin/manager decision is undoable. */
export function stagedDecisionUndoRemainingMs(
  request,
  { pendingField = 'pendingDecision', fallbackWindowMs = DECISION_UNDO_FALLBACK_MS } = {},
) {
  if (!request?.[pendingField]) return 0;
  const expiresAt = resolveDecisionUndoExpiresAt(request, { pendingField, fallbackWindowMs });
  if (!Number.isFinite(expiresAt)) return fallbackWindowMs;
  return Math.max(0, expiresAt - Date.now());
}

export function isDecisionUndoExpired(expiresAtMs) {
  return Number.isFinite(expiresAtMs) && Date.now() >= expiresAtMs;
}

/** Attendance check-in/out undo popup duration from API undo.expiresAt. */
export function attendanceUndoRemainingMs(undoPayload, fallbackMs = ATTENDANCE_UNDO_FALLBACK_MS) {
  const expiresAt = Number(undoPayload?.expiresAt);
  return undoRemainingMs(Number.isFinite(expiresAt) ? expiresAt : null, { fallbackMs });
}
