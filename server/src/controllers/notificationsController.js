import { paginationSchema } from '../../../shared/validation/common.js';
import { notificationIdSchema } from '../../../shared/validation/notifications.js';
import {
  getUnreadCount,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  clearAllNotifications,
} from '../services/notificationService.js';

export async function listForCurrentUser(req, res) {
  const { page, limit } = paginationSchema.parse(req.query);
  const result = await listNotifications(req.user._id, { page, limit });
  res.json(result);
}

export async function getUnreadCountForCurrentUser(req, res) {
  const unreadCount = await getUnreadCount(req.user._id);
  res.json({ unreadCount });
}

export async function markOneRead(req, res) {
  const { id } = notificationIdSchema.parse(req.params);
  const notification = await markNotificationRead(req.user._id, id);
  res.json({ notification });
}

export async function markAllRead(req, res) {
  const result = await markAllNotificationsRead(req.user._id);
  res.json(result);
}

export async function clearAll(req, res) {
  const result = await clearAllNotifications(req.user._id);
  res.json(result);
}
