const STATUS_CLASS = {
  pending: 'badge-warning',
  approved: 'badge-success',
  rejected: 'badge-muted',
  cancelled: 'badge-muted',
};

export default function LeaveStatusBadge({ status }) {
  return (
    <span className={`badge ${STATUS_CLASS[status] ?? 'badge-info'}`}>
      {status ? status.charAt(0).toUpperCase() + status.slice(1) : '—'}
    </span>
  );
}
