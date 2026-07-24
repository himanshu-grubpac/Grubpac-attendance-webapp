import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { PERMISSIONS } from '@shared/permissions.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useEscapeKey } from '../hooks/useEscapeKey.js';
import { notificationsApi } from '../services/api.js';
import { formatISTDateTime } from '../utils/datetime.js';

function BellIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </svg>
  );
}

export default function NotificationBell() {
  const { hasPermission } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const panelId = useId();
  const panelRef = useRef(null);
  const buttonRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [notifications, setNotifications] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);

  const canRead = hasPermission(PERMISSIONS.NOTIFICATIONS_READ);

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
    setLoading(true);
    try {
      const data = await notificationsApi.list({ page: 1, limit: 20 });
      setNotifications(data.notifications ?? []);
      setUnreadCount(data.unreadCount ?? 0);
    } catch {
      setNotifications([]);
    } finally {
      setLoading(false);
    }
  }, [canRead]);

  useEffect(() => {
    refreshUnreadCount();
    const interval = setInterval(refreshUnreadCount, 60_000);
    return () => clearInterval(interval);
  }, [refreshUnreadCount]);

  useEffect(() => {
    if (!open) return undefined;

    loadNotifications();

    function handlePointerDown(event) {
      if (
        panelRef.current?.contains(event.target) ||
        buttonRef.current?.contains(event.target)
      ) {
        return;
      }
      setOpen(false);
    }

    document.addEventListener('mousedown', handlePointerDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
    };
  }, [open, loadNotifications]);

  useEscapeKey(open, () => setOpen(false));

  useEffect(() => {
    setOpen(false);
  }, [location.pathname]);

  if (!canRead) return null;

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

    if (notification.link) {
      setOpen(false);
      navigate(notification.link);
    }
  }

  return (
    <div className="notification-bell">
      <button
        ref={buttonRef}
        type="button"
        className="btn btn-ghost btn-sm notification-bell__trigger header-trigger"
        aria-label={`Notifications${unreadCount ? `, ${unreadCount} unread` : ''}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        <BellIcon />
        {unreadCount > 0 && (
          <span className="notification-bell__badge" aria-hidden="true">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div ref={panelRef} id={panelId} className="notification-bell__panel" role="dialog" aria-label="Notifications">
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
            {loading && <p className="notification-bell__empty">Loading…</p>}
            {!loading && notifications.length === 0 && (
              <p className="notification-bell__empty">No notifications yet.</p>
            )}
            {!loading &&
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
