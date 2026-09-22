import { Navigate, useLocation } from 'react-router-dom';
import { getDefaultRoute, canAccessRoute, canAccessPortalRoute } from '../config/nav.js';
import { isIntentionalAuthDeepLink } from '../utils/authNavigation.js';
import { useAuth } from '../context/AuthContext.jsx';

export default function ProtectedRoute({
  children,
  permission,
  anyPermission,
  allPermissions,
  companyHelpAccess,
  excludeCompanyHelpAccess,
  teamCreator,
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
    const returnPath = `${location.pathname}${location.search}`;
    const from = isIntentionalAuthDeepLink(returnPath) ? returnPath : undefined;
    return <Navigate to="/login" replace state={from ? { from } : undefined} />;
  }

  // First-login password gate: users with a temporary password must change it
  // before accessing anything else (except the change-password page itself).
  const changePasswordPaths = ['/admin/change-password', '/employee/change-password'];
  if (user.mustChangePassword && !changePasswordPaths.includes(location.pathname)) {
    const target =
      portal === 'admin' || loginPortal === 'admin'
        ? '/admin/change-password'
        : '/employee/change-password';
    return <Navigate to={target} replace />;
  }

  if (role && user.role !== role) {
    return <Navigate to={getDefaultRoute(user, loginPortal)} replace />;
  }

  if (portal && !canAccessPortalRoute(user, loginPortal, portal)) {
    return <Navigate to={getDefaultRoute(user, loginPortal)} replace />;
  }

  if (
    permission ||
    anyPermission ||
    allPermissions?.length ||
    companyHelpAccess ||
    excludeCompanyHelpAccess ||
    teamCreator
  ) {
    if (
      !canAccessRoute(user, {
        permission,
        anyPermission,
        allPermissions,
        companyHelpAccess,
        excludeCompanyHelpAccess,
        teamCreator,
      })
    ) {
      return <Navigate to={getDefaultRoute(user, loginPortal)} replace />;
    }
  }

  return children;
}
