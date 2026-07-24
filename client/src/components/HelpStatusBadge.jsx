const STATUS_CLASS = {
  open: 'badge-warning',
  in_progress: 'badge-info',
  resolved: 'badge-success',
  closed: 'badge-muted',
};

const STATUS_LABEL = {
  open: 'Open',
  in_progress: 'In progress',
  resolved: 'Resolved',
  closed: 'Closed',
};

export default function HelpStatusBadge({ status }) {
  return (
    <span className={`badge ${STATUS_CLASS[status] ?? 'badge-info'}`}>
      {STATUS_LABEL[status] ?? status ?? '—'}
    </span>
  );
}
