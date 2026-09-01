import { formatISTDateTime } from '../utils/datetime.js';
import { formatCheckInOutcome } from '../utils/attendanceOutcome.js';

export default function AttendanceResultCard({ result, quarterAllowance = 3, pendingLeaveFollowUp }) {
  if (!result) return null;

  const allowed = result.status === 'allowed';
  const record = result.record;
  const pendingWfh = record?.type === 'check_in' && record?.leaveStatus === 'pending';
  const outcome =
    allowed && record?.type === 'check_in'
      ? formatCheckInOutcome(record, { allowance: quarterAllowance })
      : null;

  return (
    <div className={`result-card ${allowed ? 'result-card--allowed' : 'result-card--rejected'}`}>
      <div className="result-card__status">
        {allowed ? '✓ Allowed' : '✕ Rejected'}
      </div>
      {pendingLeaveFollowUp ? (
        <p className="result-card__pending-leave alert alert--warning alert--block">
          {pendingLeaveFollowUp}
        </p>
      ) : null}
      {pendingWfh ? (
        <p className="result-card__pending-leave alert alert--warning alert--block">
          WFH approval pending — your check-in shows red until your manager approves the WFH request.
        </p>
      ) : null}
      {outcome ? (
        <p className="result-card__outcome">
          <strong>{outcome.headline}</strong>
          {outcome.detail ? <span className="muted small"> — {outcome.detail}</span> : null}
        </p>
      ) : null}
      {record && (
        <div className="result-card__meta">
          <p>
            <strong>Type:</strong> {record.type === 'check_in' ? 'Check-in' : 'Check-out'}
          </p>
          <p>
            <strong>Mode:</strong> {record.attendanceMode === 'wfh' ? 'Work from Home' : 'Office'}
          </p>
          <p>
            <strong>Time (IST):</strong> {formatISTDateTime(record.timestamp)}
          </p>
          <p>
            <strong>Distance:</strong> {record.distanceMeters?.toFixed(1)} m
          </p>
          <p>
            <strong>Accuracy:</strong> {record.accuracyMeters?.toFixed(1)} m
          </p>
          {Number.isFinite(record.latitude) && Number.isFinite(record.longitude) ? (
            <p>
              <a href={`https://www.google.com/maps?q=${record.latitude},${record.longitude}`} target="_blank" rel="noreferrer">
                View captured location
              </a>
            </p>
          ) : null}
        </div>
      )}
      {!allowed && result.rejectionReasons?.length > 0 && (
        <ul className="result-card__reasons">
          {result.rejectionReasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
