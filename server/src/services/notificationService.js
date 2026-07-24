import mongoose from 'mongoose';
import { Notification } from '../models/Notification.js';

export async function createNotification({ userId, type, title, body, link, metadata }) {
  const notification = await Notification.create({
    userId,
    type,
    title,
    body,
    link: link ?? null,
    metadata: metadata ?? {},
  });
  return notification;
}

export async function getUnreadCount(userId) {
  return Notification.countDocuments({ userId, readAt: null });
}

export async function listNotifications(userId, { page, limit }) {
  const skip = (page - 1) * limit;
  const filter = { userId };

  const [notifications, total, unreadCount] = await Promise.all([
    Notification.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit),
    Notification.countDocuments(filter),
    Notification.countDocuments({ userId, readAt: null }),
  ]);

  return {
    notifications: notifications.map((item) => item.toSafeJSON()),
    unreadCount,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit) || 1,
    },
  };
}

export async function markNotificationRead(userId, notificationId) {
  if (!mongoose.isValidObjectId(notificationId)) {
    const error = new Error('Notification not found.');
    error.statusCode = 404;
    throw error;
  }

  const notification = await Notification.findOneAndUpdate(
    { _id: notificationId, userId },
    { readAt: new Date() },
    { returnDocument: 'after' },
  );

  if (!notification) {
    const error = new Error('Notification not found.');
    error.statusCode = 404;
    throw error;
  }

  return notification.toSafeJSON();
}

export async function markAllNotificationsRead(userId) {
  const result = await Notification.updateMany(
    { userId, readAt: null },
    { readAt: new Date() },
  );
  return { updatedCount: result.modifiedCount };
}

export async function clearAllNotifications(userId) {
  const result = await Notification.deleteMany({ userId });
  return { deletedCount: result.deletedCount };
}
