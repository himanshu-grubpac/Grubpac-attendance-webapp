/**
 * Slide-in column toggle panel shared by admin tables (same markup/classes as
 * the employee-list editor so styling stays consistent).
 */
export default function ColumnEditorPanel({
  open,
  columns,
  isColumnVisible,
  onToggle,
  loading = false,
  onClose,
}) {
  if (!open) return null;
  return (
    <>
      <div
        className="slide-panel-backdrop"
        onClick={onClose}
        onKeyDown={(e) => e.key === 'Escape' && onClose()}
      />
      <div
        className="slide-panel"
        role="dialog"
        aria-label="Edit columns"
        style={{ width: '20rem' }}
        onKeyDown={(e) => e.key === 'Escape' && onClose()}
      >
        <div className="slide-panel__header">
          <div className="slide-panel__titles">
            <h2 className="slide-panel__title">Edit columns</h2>
            <p className="slide-panel__subtitle">
              Choose which columns to display in the table.
            </p>
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={onClose}
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        <div className="slide-panel__body">
          {loading ? (
            <p className="muted small" role="status">
              Loading column preferences…
            </p>
          ) : (
            <ul className="column-editor-list">
              {columns.map((col) => (
                <li key={col.key} className="column-editor-list__item">
                  <label
                    className={`column-editor-list__label${col.always ? ' column-editor-list__label--locked' : ''}`}
                  >
                    <input
                      type="checkbox"
                      className="column-editor-list__checkbox"
                      checked={isColumnVisible(col.key)}
                      onChange={() => onToggle(col.key)}
                      disabled={col.always || loading}
                    />
                    <span className="column-editor-list__text">{col.label}</span>
                    {col.always ? (
                      <span className="column-editor-list__badge">Always shown</span>
                    ) : null}
                  </label>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="slide-panel__footer">
          <div className="slide-panel__actions">
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={onClose}
            >
              Done
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
