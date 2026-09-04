const PRIORITY_CLASS = {
  high: 'badge-warning',
  medium: 'badge-info',
  low: 'badge-success',
};

const PRIORITY_LABEL = {
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

export default function HelpPriorityBadge({ priority }) {
  return (
    <span className={`badge ${PRIORITY_CLASS[priority] ?? 'badge-muted'}`}>
      {PRIORITY_LABEL[priority] ?? priority ?? '—'}
    </span>
  );
}
