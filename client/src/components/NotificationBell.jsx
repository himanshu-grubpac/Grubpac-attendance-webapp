import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import {
  hasCompanyHelpAccess,
  NOTIFICATIONS_PORTAL_PERMISSIONS,
} from '@shared/permissions.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useEscapeKey } from '../hooks/useEscapeKey.js';
import { notificationsApi } from '../services/api.js';
import { formatISTDateTime } from '../utils/datetime.js';
import { usePortalSync } from '../hooks/usePortalSync.js';
import { PORTAL_TOPICS } from '../utils/portalSync.js';

/** Align help bell links with Help tickets vs Team issues nav (handles stale payloads). */
function resolveNotificationLink(notification, userPermissions) {
  const link = notification?.link;
  if (!link) return link;

  const teamHelpMatch = link.match(/^\/admin\/help\/team\/([^/]+)$/);
  if (
    !teamHelpMatch ||
    !notification.type?.startsWith('help.') ||
    !hasCompanyHelpAccess(userPermissions)
  ) {
    return link;
  }

  return `/admin/help/tickets/${teamHelpMatch[1]}`;
}

function BellIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </svg>
  );
}

export default function NotificationBell() {
  const { hasAnyPermission, user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const panelId = useId();
  const rootRef = useRef(null);
  const notificationsRef = useRef([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [listLoaded, setListLoaded] = useState(false);
  const [notifications, setNotifications] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);

  notificationsRef.current = notifications;

  const canRead = hasAnyPermission(NOTIFICATIONS_PORTAL_PERMISSIONS);

  const refreshUnreadCount = useCallback(async () => {
    if (!canRead) return;
    try {
      const data = await notificationsApi.getUnreadCount();
      setUnreadCount(data.unreadCount ?? 0);
    } catch {
      // Ignore transient failures for badge polling.
    }
  }, [canRead]);

  const loadNotifications = useCallback(async () => {
    if (!canRead) return;
    const isInitialLoad = notificationsRef.current.length === 0;
    if (isInitialLoad) setLoading(true);
    try {
      const data = await notificationsApi.list({ page: 1, limit: 20 });
      setNotifications(data.notifications ?? []);
      setUnreadCount(data.unreadCount ?? 0);
    } catch {
      if (isInitialLoad) setNotifications([]);
    } finally {
      setListLoaded(true);
      if (isInitialLoad) setLoading(false);
    }
  }, [canRead]);

  useEffect(() => {
    refreshUnreadCount();
    const interval = setInterval(refreshUnreadCount, 60_000);
    return () => clearInterval(interval);
  }, [refreshUnreadCount]);

  usePortalSync(() => {
    void refreshUnreadCount();
  }, { topics: [PORTAL_TOPICS.LEAVE, PORTAL_TOPICS.HELP] });

  useEffect(() => {
    if (!open) return undefined;
    void loadNotifications();
  }, [open, loadNotifications]);

  useEffect(() => {
    if (!open) return undefined;

    let removeListener = () => {};
    const frameId = requestAnimationFrame(() => {
      function handlePointerDown(event) {
        if (rootRef.current?.contains(event.target)) return;
        setOpen(false);
      }

      document.addEventListener('pointerdown', handlePointerDown);
      removeListener = () => document.removeEventListener('pointerdown', handlePointerDown);
    });

    return () => {
      cancelAnimationFrame(frameId);
      removeListener();
    };
  }, [open]);

  useEscapeKey(open, () => setOpen(false));

  useEffect(() => {
    setOpen(false);
  }, [location.pathname]);

  if (!canRead) return null;

  function toggleOpen() {
    setOpen((wasOpen) => {
      const next = !wasOpen;
      if (next && !listLoaded && notificationsRef.current.length === 0) {
        setLoading(true);
      }
      return next;
    });
  }

  async function handleMarkAllRead() {
    try {
      await notificationsApi.markAllRead();
      setNotifications((items) =>
        items.map((item) => ({ ...item, readAt: item.readAt ?? new Date().toISOString() })),
      );
      setUnreadCount(0);
    } catch {
      // Keep current state on failure.
    }
  }

  async function handleClearAll() {
    try {
      await notificationsApi.clearAll();
      setNotifications([]);
      setUnreadCount(0);
    } catch (err) {
      console.error('Failed to clear notifications:', err);
      // Keep current state on failure.
    }
  }

  async function handleNotificationClick(notification) {
    if (!notification.readAt) {
      try {
        const data = await notificationsApi.markRead(notification.id);
        setNotifications((items) =>
          items.map((item) => (item.id === notification.id ? data.notification : item)),
        );
        setUnreadCount((count) => Math.max(0, count - 1));
      } catch {
        // Still allow navigation if mark-read fails.
      }
    }

    const target = resolveNotificationLink(notification, user?.permissions ?? []);
    if (target) {
      setOpen(false);
      navigate(target);
    }
  }

  const showLoadingState = loading && notifications.length === 0;
  const showEmptyState = listLoaded && !loading && notifications.length === 0;

  return (
    <div className="notification-bell" ref={rootRef}>
      <button
        type="button"
        className="btn btn-ghost btn-sm notification-bell__trigger header-trigger"
        aria-label={`Notifications${unreadCount ? `, ${unreadCount} unread` : ''}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={open ? panelId : undefined}
        onClick={toggleOpen}
      >
        <BellIcon />
        {unreadCount > 0 && (
          <span className="notification-bell__badge" aria-hidden="true">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div id={panelId} className="notification-bell__panel" role="dialog" aria-label="Notifications">
          <div className="notification-bell__header">
            <strong>Notifications</strong>
            <div className="notification-bell__header-actions">
              {unreadCount > 0 && (
                <button type="button" className="btn btn-ghost btn-sm" onClick={handleMarkAllRead}>
                  Mark all read
                </button>
              )}
              {notifications.length > 0 && (
                <button type="button" className="btn btn-ghost btn-sm notification-bell__clear" onClick={handleClearAll}>
                  Clear all
                </button>
              )}
            </div>
          </div>

          <div className="notification-bell__list">
            {showLoadingState && <p className="notification-bell__empty">Loading…</p>}
            {showEmptyState && (
              <p className="notification-bell__empty">No notifications yet.</p>
            )}
            {notifications.length > 0 &&
              notifications.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`notification-bell__item${item.readAt ? '' : ' notification-bell__item--unread'}`}
                  onClick={() => handleNotificationClick(item)}
                >
                  <span className="notification-bell__item-title">{item.title}</span>
                  <span className="notification-bell__item-body">{item.body}</span>
                  <span className="notification-bell__item-time">
                    {formatISTDateTime(item.createdAt)}
                  </span>
                </button>
              ))}
          </div>
        </div>
      )}
    </div>
  );
}
