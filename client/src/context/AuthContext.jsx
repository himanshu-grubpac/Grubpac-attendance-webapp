import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import {
  ADMIN_PORTAL_PERMISSIONS,
  PERMISSIONS,
  hasAdminPortalAccess,
  hasAnyPermission as userHasAnyPermission,
  hasPermission as userHasPermission,
} from '@shared/permissions.js';
import { authApi } from '../services/api.js';
import { fetchSessionWithRetry } from '../utils/serverReady.js';

const AuthContext = createContext(null);

const LOGIN_PORTAL_KEY = 'attendance.loginPortal';

function readStoredLoginPortal() {
  try {
    const value = localStorage.getItem(LOGIN_PORTAL_KEY);
    if (value === 'admin' || value === 'employee') return value;
  } catch {
    // Ignore storage failures.
  }
  return null;
}

function storeLoginPortal(portal) {
  try {
    if (portal) {
      localStorage.setItem(LOGIN_PORTAL_KEY, portal);
    } else {
      localStorage.removeItem(LOGIN_PORTAL_KEY);
    }
  } catch {
    // Ignore storage failures.
  }
}

function inferLoginPortal(user) {
  if (hasAdminPortalAccess(user?.permissions)) {
    return 'admin';
  }
  return 'employee';
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loginPortal, setLoginPortal] = useState(() => readStoredLoginPortal());
  const [loading, setLoading] = useState(true);
  const [loggingOut, setLoggingOut] = useState(false);

  const logout = useCallback(async () => {
    setLoggingOut(true);
    try {
      await authApi.logout();
    } catch {
      // Session may already be expired.
    }
    setUser(null);
    setLoginPortal(null);
    storeLoginPortal(null);
    setLoggingOut(false);
  }, []);

  const login = useCallback(async (role, identifier, password) => {
    const result =
      role === 'admin'
        ? await authApi.adminLogin(identifier, password)
        : await authApi.employeeLogin(identifier, password);
    const portal = result.user?.loginPortal ?? role;
    setUser(result.user);
    setLoginPortal(portal);
    storeLoginPortal(portal);
    return { user: result.user, loginPortal: portal };
  }, []);

  const switchPortal = useCallback(
    (nextPortal) => {
      if (nextPortal !== 'admin' && nextPortal !== 'employee') return null;
      setLoginPortal(nextPortal);
      storeLoginPortal(nextPortal);
      return nextPortal;
    },
    [],
  );

  const refreshUser = useCallback(async (nextUser) => {
    if (nextUser) {
      setUser(nextUser);
      return nextUser;
    }
    const result = await authApi.me();
    setUser(result.user);
    return result.user;
  }, []);

  useEffect(() => {
    let cancelled = false;

    fetchSessionWithRetry()
      .then(({ user: currentUser }) => {
        if (cancelled) return;
        setUser(currentUser);
        if (!currentUser) {
          setLoginPortal(null);
          storeLoginPortal(null);
          return;
        }
        const stored = readStoredLoginPortal();
        const portal = stored ?? inferLoginPortal(currentUser);
        setLoginPortal(portal);
        if (!stored) storeLoginPortal(portal);
      })
      .catch(() => {
        if (!cancelled) {
          setUser(null);
          setLoginPortal(null);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const value = useMemo(
    () => ({
      user,
      loginPortal,
      loading,
      loggingOut,
      login,
      logout,
      refreshUser,
      switchPortal,
      permissions: user?.permissions ?? [],
      isAdmin: loginPortal === 'admin',
      hasAdminPortalAccess: userHasAnyPermission(user?.permissions, ADMIN_PORTAL_PERMISSIONS),
      hasEmployeePortalAccess: userHasPermission(user?.permissions, PERMISSIONS.ATTENDANCE_READ_OWN),
      canSwitchPortal:
        userHasAnyPermission(user?.permissions, ADMIN_PORTAL_PERMISSIONS) &&
        userHasPermission(user?.permissions, PERMISSIONS.ATTENDANCE_READ_OWN),
      hasPermission: (permission) => userHasPermission(user?.permissions, permission),
      hasAnyPermission: (permissions) => userHasAnyPermission(user?.permissions, permissions),
    }),
    [user, loginPortal, loading, loggingOut, login, logout, refreshUser, switchPortal],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

export { PERMISSIONS };
