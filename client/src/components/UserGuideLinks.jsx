import { useAuth } from '../context/AuthContext.jsx';
import { resolveUserGuideLinks } from '../utils/userGuide.js';

export default function UserGuideLinks() {
  const { user, loginPortal } = useAuth();
  const links = resolveUserGuideLinks(user, loginPortal);

  if (!links.length) {
    return null;
  }

  return (
    <section className="card user-guide-links" aria-label="User guides">
      <p className="card__section-title">User guide</p>
      <p className="muted small user-guide-links__intro">
        Step-by-step help for Grubpac Attendance — attendance, leave, WFH, and your role in the
        portal.
      </p>
      <ul className="user-guide-links__list">
        {links.map((link) => (
          <li key={link.key}>
            <a
              href={link.path}
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn-ghost btn-sm user-guide-links__btn"
            >
              Open {link.label}
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
