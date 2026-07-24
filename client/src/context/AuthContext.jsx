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
  hasAnyPermission as userHasAnyPermission,
  hasPermission as userHasPermission,
} from '@shared/permissions.js';
import { authApi } from '../services/api.js';
import { fetchSessionWithRetry } from '../utils/serverReady.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
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
    setLoggingOut(false);
  }, []);

  const login = useCallback(async (role, identifier, password) => {
    const result =
      role === 'admin'
        ? await authApi.adminLogin(identifier, password)
        : await authApi.employeeLogin(identifier, password);
    setUser(result.user);
    return result.user;
  }, []);

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
        if (!cancelled) setUser(currentUser);
      })
      .catch(() => {
        if (!cancelled) setUser(null);
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
      loading,
      loggingOut,
      login,
      logout,
      refreshUser,
      permissions: user?.permissions ?? [],
      isAdmin: userHasAnyPermission(user?.permissions, ADMIN_PORTAL_PERMISSIONS),
      hasPermission: (permission) => userHasPermission(user?.permissions, permission),
      hasAnyPermission: (permissions) => userHasAnyPermission(user?.permissions, permissions),
    }),
    [user, loading, loggingOut, login, logout, refreshUser],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

export { PERMISSIONS };
