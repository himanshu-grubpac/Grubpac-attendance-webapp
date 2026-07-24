/** Shared empty-state pattern for lists, tables, and dashboard branches. */
export const EMPTY_ICONS = {
  default: '◌',
  calendar: '◷',
  leave: '▤',
  users: '◎',
  help: '?',
  inbox: '☰',
  payroll: '₹',
  settings: '⚙',
};

export default function EmptyState({
  icon = EMPTY_ICONS.default,
  title,
  description,
  action,
  compact = false,
  className = '',
}) {
  return (
    <div
      className={`empty-state${compact ? ' empty-state--compact' : ''}${className ? ` ${className}` : ''}`}
      role="status"
    >
      {icon ? (
        <div className="empty-state__icon" aria-hidden="true">
          {icon}
        </div>
      ) : null}
      {title ? <p className="empty-state__title">{title}</p> : null}
      {description ? <p className="empty-state__description">{description}</p> : null}
      {action ? <div className="empty-state__action">{action}</div> : null}
    </div>
  );
}
