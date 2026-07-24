import { Link } from 'react-router-dom';

function BackChevronIcon() {
  return (
    <svg
      className="back-link__icon"
      viewBox="0 0 24 24"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M15 18l-6-6 6-6" />
    </svg>
  );
}

export default function BackLink({ to, onClick, children, className = '', compact = false }) {
  const classes = ['back-link', compact ? 'back-link--compact' : '', className]
    .filter(Boolean)
    .join(' ');

  const content = (
    <>
      <BackChevronIcon />
      <span className="back-link__label">{children}</span>
    </>
  );

  if (to) {
    return (
      <Link to={to} className={classes}>
        {content}
      </Link>
    );
  }

  return (
    <button type="button" onClick={onClick} className={classes}>
      {content}
    </button>
  );
}
