/** Compact loading indicator for full-page or in-card async states. */
export default function PageLoading({ text = 'Loading…', compact = false }) {
  return (
    <div
      className={`loading-block${compact ? ' loading-block--card' : ''}`}
      role="status"
      aria-live="polite"
    >
      <span className="spinner spinner--sm" aria-hidden="true" />
      <span className="loading-block__text">{text}</span>
    </div>
  );
}
