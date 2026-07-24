import { formatISTDateTime } from '../utils/datetime.js';

export default function AttendanceResultCard({ result }) {
  if (!result) return null;

  const allowed = result.status === 'allowed';
  const record = result.record;

  return (
    <div className={`result-card ${allowed ? 'result-card--allowed' : 'result-card--rejected'}`}>
      <div className="result-card__status">
        {allowed ? '✓ Allowed' : '✕ Rejected'}
      </div>
      {record && (
        <div className="result-card__meta">
          <p>
            <strong>Type:</strong> {record.type === 'check_in' ? 'Check-in' : 'Check-out'}
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
