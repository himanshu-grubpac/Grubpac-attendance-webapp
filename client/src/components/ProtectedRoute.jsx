import { Navigate } from 'react-router-dom';
import { getDefaultRoute, canAccessRoute } from '../config/nav.js';
import { useAuth } from '../context/AuthContext.jsx';

export default function ProtectedRoute({
  children,
  permission,
  anyPermission,
  allPermissions,
  role,
}) {
  const { user, loading, loggingOut } = useAuth();

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
    return <Navigate to="/login" replace />;
  }

  if (role && user.role !== role) {
    return <Navigate to={getDefaultRoute(user)} replace />;
  }

  if (permission || anyPermission || allPermissions?.length) {
    if (!canAccessRoute(user, { permission, anyPermission, allPermissions })) {
      return <Navigate to={getDefaultRoute(user)} replace />;
    }
  }

  return children;
}
