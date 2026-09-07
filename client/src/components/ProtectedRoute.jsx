import { Navigate, useLocation } from 'react-router-dom';
import { getDefaultRoute, canAccessRoute, canAccessPortalRoute } from '../config/nav.js';
import { useAuth } from '../context/AuthContext.jsx';

export default function ProtectedRoute({
  children,
  permission,
  anyPermission,
  allPermissions,
  role,
  portal,
}) {
  const { user, loginPortal, loading, loggingOut } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="page-center">
        <div className="page-loading">
          <div className="spinner" aria-hidden="true" />
          <p className="page-loading__text">Loading your session…</p>
        </div>
      </div>
    );
  }

  if (loggingOut) {
    return (
      <>
        <div className="sign-out-overlay page-center" aria-live="polite" aria-busy="true">
          <div className="page-loading">
            <div className="spinner" aria-hidden="true" />
            <p className="page-loading__text">Signing out…</p>
          </div>
        </div>
        {children}
      </>
    );
  }

  if (!user) {
    // Preserve the full deep link (including ?decision&requestId from email
    // links) so login can return the user to it instead of dropping it.
    return <Navigate to="/login" replace state={{ from: `${location.pathname}${location.search}` }} />;
  }

  if (role && user.role !== role) {
    return <Navigate to={getDefaultRoute(user, loginPortal)} replace />;
  }

  if (portal && !canAccessPortalRoute(user, loginPortal, portal)) {
    return <Navigate to={getDefaultRoute(user, loginPortal)} replace />;
  }

  if (permission || anyPermission || allPermissions?.length) {
    if (!canAccessRoute(user, { permission, anyPermission, allPermissions })) {
      return <Navigate to={getDefaultRoute(user, loginPortal)} replace />;
    }
  }

  return children;
}
