import mongoose from 'mongoose';
import {
  PERMISSIONS,
  hasCompanyHelpAccess,
  hasCompanyHelpManageAccess,
  hasPermission,
} from '../../../shared/permissions.js';
import {
  assertDepartmentInAccessibleSet,
  isUserInTeamScope,
  resolveManagedTeamUserIds,
} from './teamScopeService.js';
import { HelpTicket, HELP_TICKET_POPULATE } from '../models/HelpTicket.js';
import { HelpComment, HELP_COMMENT_POPULATE } from '../models/HelpComment.js';
import { HelpAttachment, HELP_ATTACHMENT_POPULATE } from '../models/HelpAttachment.js';
import { User, USER_POPULATE_FIELDS } from '../models/User.js';
import { Role } from '../models/Role.js';
import { createNotification } from './notificationService.js';
import { deleteS3Objects } from './helpAttachmentService.js';
import { auditLog } from '../utils/auditLog.js';

function throwError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  throw error;
}

async function loadTicket(ticketId) {
  if (!mongoose.isValidObjectId(ticketId)) {
    throwError('Help ticket not found.', 404);
  }

  const ticket = await HelpTicket.findById(ticketId).populate(HELP_TICKET_POPULATE);
  if (!ticket) {
    throwError('Help ticket not found.', 404);
  }
  return ticket;
}

async function loadCreator(creatorId) {
  const user = await User.findById(creatorId).populate(USER_POPULATE_FIELDS);
  if (!user) {
    throwError('Ticket creator not found.', 404);
  }
  return user;
}

function getCreatorId(ticket) {
  return ticket.createdBy?._id?.toString() ?? ticket.createdBy?.toString?.() ?? null;
}

function getManagerId(creator) {
  return (
    creator.reportingManagerId?._id?.toString() ??
    creator.reportingManagerId?.toString?.() ??
    null
  );
}

export async function findUsersWithPermission(permission) {
  const roles = await Role.find({ permissions: permission }).select('_id');
  if (!roles.length) return [];
  const roleIds = roles.map((role) => role._id);
  return User.find({ isActive: true, roleId: { $in: roleIds } })
    .select('_id name roleId')
    .populate({ path: 'roleId', select: 'permissions' });
}

async function getUserPermissions(user) {
  if (user.roleId && typeof user.roleId === 'object' && Array.isArray(user.roleId.permissions)) {
    return user.roleId.permissions;
  }
  const roleId = user.roleId?._id ?? user.roleId;
  if (!roleId) return [];
  const role = await Role.findById(roleId).select('permissions').lean();
  return role?.permissions ?? [];
}

async function resolveAdminHelpTicketLink(user, ticketId) {
  const permissions = await getUserPermissions(user);
  return hasCompanyHelpAccess(permissions)
    ? `/admin/help/tickets/${ticketId}`
    : `/admin/help/team/${ticketId}`;
}

function canReceiveHelpStakeholderNotify(permissions) {
  return (
    hasPermission(permissions, PERMISSIONS.HELP_TICKET_R) ||
    hasPermission(permissions, PERMISSIONS.HELP_TICKET_U) ||
    hasPermission(permissions, PERMISSIONS.HELP_MANAGE)
  );
}

/**
 * Help ticket bell recipients: company-wide help managers, the creator's
 * reporting manager when they can view help, and team-scoped managers whose
 * managed team includes the creator. Deduped — never every help.ticket.u holder.
 */
async function resolveHelpNotifyRecipients(creatorId) {
  const creator = await loadCreator(creatorId);
  const notifiedIds = new Set();
  const recipients = [];

  const helpManagers = await findUsersWithPermission(PERMISSIONS.HELP_MANAGE);

  for (const user of helpManagers) {
    const permissions = await getUserPermissions(user);
    if (!hasCompanyHelpManageAccess(permissions)) {
      continue;
    }
    recipients.push({ user, permissions });
    notifiedIds.add(user._id.toString());
  }

  const managerId = getManagerId(creator);
  if (managerId && !notifiedIds.has(managerId)) {
    const manager = await User.findById(managerId)
      .select('_id name roleId managedDepartmentIds departmentId')
      .populate({ path: 'roleId', select: 'permissions slug' });
    if (manager) {
      const permissions = await getUserPermissions(manager);
      if (canReceiveHelpStakeholderNotify(permissions)) {
        recipients.push({ user: manager, permissions });
        notifiedIds.add(managerId);
      }
    }
  }

  for (const user of helpManagers) {
    const userId = user._id.toString();
    if (notifiedIds.has(userId)) {
      continue;
    }
    const scopedUser = await User.findById(user._id)
      .select('_id name roleId managedDepartmentIds departmentId')
      .populate({ path: 'roleId', select: 'permissions slug' });
    if (!scopedUser) {
      continue;
    }
    const permissions = await getUserPermissions(scopedUser);
    if (
      canReceiveHelpStakeholderNotify(permissions) &&
      (await isUserInTeamScope(scopedUser, permissions, creatorId))
    ) {
      recipients.push({ user: scopedUser, permissions });
      notifiedIds.add(userId);
    }
  }

  return recipients;
}

async function notifyHelpStakeholders({
  creatorId,
  actorId,
  type,
  title,
  body,
  ticketId,
  metadata = {},
}) {
  const notifiedIds = new Set([actorId]);
  const recipients = await resolveHelpNotifyRecipients(creatorId);

  await Promise.all(
    recipients
      .filter(({ user }) => !notifiedIds.has(user._id.toString()))
      .map(async ({ user, permissions }) => {
        notifiedIds.add(user._id.toString());
        return createNotification({
          userId: user._id,
          type,
          title,
          body,
          link: await resolveAdminHelpTicketLink(user, ticketId),
          metadata,
        });
      }),
  );
}

export async function canViewTicket(actor, ticket, permissions) {
  const actorId = actor._id.toString();
  const creatorId = getCreatorId(ticket);

  if (creatorId === actorId) return true;

  const canViewTeamTickets =
    hasPermission(permissions, PERMISSIONS.HELP_TICKET_R) ||
    hasPermission(permissions, PERMISSIONS.HELP_TICKET_U) ||
    hasPermission(permissions, PERMISSIONS.HELP_MANAGE);

  if (!canViewTeamTickets) {
    return false;
  }

  if (hasCompanyHelpAccess(permissions) || hasCompanyHelpManageAccess(permissions)) {
    return true;
  }

  if (creatorId) {
    return isUserInTeamScope(actor, permissions, creatorId);
  }

  return false;
}

export async function canManageTicket(actor, ticket, permissions) {
  if (
    !hasPermission(permissions, PERMISSIONS.HELP_MANAGE) &&
    !hasPermission(permissions, PERMISSIONS.HELP_SET_PRIORITY)
  ) {
    return false;
  }

  if (hasCompanyHelpManageAccess(permissions)) {
    return true;
  }

  const actorId = actor._id.toString();
  const creatorId = getCreatorId(ticket);
  if (creatorId === actorId) return false;

  if (creatorId) {
    return isUserInTeamScope(actor, permissions, creatorId);
  }

  return false;
}

export async function createHelpTicket(actor, payload, permissions = [], auditContext = {}) {
  const canSetPriority =
    hasPermission(permissions, PERMISSIONS.HELP_MANAGE) ||
    hasPermission(permissions, PERMISSIONS.HELP_SET_PRIORITY);
  const ticket = await HelpTicket.create({
    title: payload.title,
    category: payload.category,
    description: payload.description,
    priority: canSetPriority && payload.priority ? payload.priority : 'medium',
    status: 'open',
    createdBy: actor._id,
  });

  await notifyOnTicketCreated(actor, ticket);

  auditLog('help_ticket_created', {
    userId: actor._id.toString(),
    ticketId: ticket._id.toString(),
    category: ticket.category,
    priority: ticket.priority,
    next: { status: 'open', category: ticket.category, priority: ticket.priority },
    ...auditContext,
  });

  return (await HelpTicket.findById(ticket._id).populate(HELP_TICKET_POPULATE)).toSafeJSON();
}

async function notifyOnTicketCreated(creator, ticket) {
  const link = `/employee/help/${ticket._id.toString()}`;
  const title = 'New help ticket';
  const body = `${creator.name} raised "${ticket.title}" (${ticket.category}).`;
  const ticketId = ticket._id.toString();

  await notifyHelpStakeholders({
    creatorId: creator._id.toString(),
    actorId: creator._id.toString(),
    type: 'help.new',
    title,
    body,
    ticketId,
    metadata: { ticketId },
  });

  await createNotification({
    userId: creator._id,
    type: 'help.created',
    title: 'Help ticket submitted',
    body: `Your ticket "${ticket.title}" was submitted and is open.`,
    link,
    metadata: { ticketId },
  });
}

export async function listHelpTickets(actor, permissions, query) {
  const filter = {};
  const scope = query.scope;

  if (scope === 'mine') {
    filter.createdBy = actor._id;
  } else if (scope === 'team') {
    if (
      !hasPermission(permissions, PERMISSIONS.HELP_TICKET_R) &&
      !hasPermission(permissions, PERMISSIONS.HELP_TICKET_U) &&
      !hasPermission(permissions, PERMISSIONS.HELP_MANAGE)
    ) {
      throwError('You do not have permission to view team help tickets.', 403);
    }
    const teamIds = await resolveManagedTeamUserIds(actor);
    filter.createdBy = { $in: teamIds };

    if (query.departmentId) {
      await assertDepartmentInAccessibleSet(actor, permissions, query.departmentId);
      const deptMembers = await User.find({
        departmentId: query.departmentId,
        _id: { $in: teamIds },
      }).select('_id');
      filter.createdBy = { $in: deptMembers.map((user) => user._id) };
    }
  } else if (scope === 'all') {
    if (!hasCompanyHelpManageAccess(permissions)) {
      throwError('You do not have permission to view all help tickets.', 403);
    }
  } else {
    filter.createdBy = actor._id;
  }

  if (query.status) {
    filter.status = query.status;
  }
  if (query.category) {
    filter.category = query.category;
  }
  if (query.priority) {
    filter.priority = query.priority;
  }
  if (query.search) {
    const regex = new RegExp(query.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [{ title: regex }, { description: regex }];
  }
  if (query.dateFrom || query.dateTo) {
    filter.createdAt = {};
    if (query.dateFrom) {
      filter.createdAt.$gte = new Date(query.dateFrom + 'T00:00:00.000Z');
    }
    if (query.dateTo) {
      filter.createdAt.$lte = new Date(query.dateTo + 'T23:59:59.999Z');
    }
  }

  const skip = (query.page - 1) * query.limit;
  const [tickets, total] = await Promise.all([
    HelpTicket.find(filter)
      .populate(HELP_TICKET_POPULATE)
      // _id tiebreaker keeps offset pagination stable when timestamps tie.
      .sort({ createdAt: -1, _id: -1 })
      .skip(skip)
      .limit(query.limit),
    HelpTicket.countDocuments(filter),
  ]);

  const ticketsWithAccess = await Promise.all(
    tickets.map(async (item) => ({
      ...item.toSafeJSON(),
      canManage: await canManageTicket(actor, item, permissions),
    })),
  );

  return {
    tickets: ticketsWithAccess,
    pagination: {
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.ceil(total / query.limit) || 1,
    },
  };
}

export async function getHelpTicketById(ticketId, actor, permissions) {
  const ticket = await loadTicket(ticketId);
  if (!(await canViewTicket(actor, ticket, permissions))) {
    throwError('You do not have permission to view this ticket.', 403);
  }

  const [comments, attachmentDocs] = await Promise.all([
    HelpComment.find({ ticketId: ticket._id })
      .populate(HELP_COMMENT_POPULATE)
      .sort({ createdAt: 1 }),
    HelpAttachment.find({ ticketId: ticket._id, status: 'confirmed', commentId: null })
      .populate(HELP_ATTACHMENT_POPULATE)
      .sort({ createdAt: 1 }),
  ]);

  const commentIds = comments.map((c) => c._id);
  const commentAttachments = commentIds.length > 0
    ? await HelpAttachment.find({
        ticketId: ticket._id,
        commentId: { $in: commentIds },
        status: 'confirmed',
      })
        .populate(HELP_ATTACHMENT_POPULATE)
        .sort({ createdAt: 1 })
    : [];

  const attachmentsByComment = {};
  for (const att of commentAttachments) {
    const cId = att.commentId?.toString?.() ?? att.commentId?.toString?.() ?? null;
    if (cId) {
      if (!attachmentsByComment[cId]) attachmentsByComment[cId] = [];
      attachmentsByComment[cId].push(att.toSafeJSON());
    }
  }

  const canManage = await canManageTicket(actor, ticket, permissions);

  return {
    ticket: { ...ticket.toSafeJSON(), canManage },
    comments: comments.map((item) => ({
      ...item.toSafeJSON(),
      attachments: attachmentsByComment[item._id.toString()] ?? [],
    })),
    attachments: attachmentDocs.map((item) => item.toSafeJSON()),
  };
}

export async function updateHelpTicketStatus(ticketId, actor, permissions, payload, auditContext = {}) {
  const ticket = await loadTicket(ticketId);
  if (!(await canManageTicket(actor, ticket, permissions))) {
    throwError('You are not authorized to update this ticket.', 403);
  }

  const previousStatus = ticket.status;
  const previousPriority = ticket.priority;

  if (payload.status !== undefined && payload.status !== previousStatus) {
    if (
      !hasPermission(permissions, PERMISSIONS.HELP_TICKET_X1) &&
      !hasPermission(permissions, PERMISSIONS.HELP_TICKET_U)
    ) {
      throwError('You do not have permission to change ticket status.', 403);
    }
    ticket.status = payload.status;
  }

  if (payload.priority !== undefined && payload.priority !== previousPriority) {
    if (
      !hasPermission(permissions, PERMISSIONS.HELP_SET_PRIORITY) &&
      !hasPermission(permissions, PERMISSIONS.HELP_MANAGE)
    ) {
      throwError('You do not have permission to change ticket priority.', 403);
    }
    ticket.priority = payload.priority;
  }

  if (payload.assignedTo !== undefined) {
    if (payload.assignedTo) {
      const assignee = await User.findById(payload.assignedTo);
      if (!assignee || !assignee.isActive) {
        throwError('Assigned user not found.');
      }
      ticket.assignedTo = assignee._id;
    } else {
      ticket.assignedTo = null;
    }
  } else if (!ticket.assignedTo && payload.status === 'in_progress') {
    ticket.assignedTo = actor._id;
  }

  await ticket.save();
  await ticket.populate(HELP_TICKET_POPULATE);

  const creatorId = getCreatorId(ticket);
  if (creatorId && creatorId !== actor._id.toString()) {
    const changed = [];
    if (payload.status !== undefined && payload.status !== previousStatus) {
      changed.push(`status to ${payload.status.replace('_', ' ')}`);
    }
    if (payload.priority !== undefined && payload.priority !== previousPriority) {
      changed.push(`priority to ${payload.priority}`);
    }

    if (changed.length > 0) {
      await createNotification({
        userId: creatorId,
        type: 'help.status',
        title: 'Help ticket updated',
        body: `Your ticket "${ticket.title}" — ${changed.join(' and ')}.`,
        link: `/employee/help/${ticket._id.toString()}`,
        metadata: { ticketId: ticket._id.toString(), status: payload.status, priority: payload.priority },
      });
    }
  }

  auditLog('help_ticket_status_updated', {
    userId: actor._id.toString(),
    ticketId: ticket._id.toString(),
    previousStatus,
    status: payload.status ?? ticket.status,
    previousPriority,
    priority: ticket.priority,
    previous: { status: previousStatus, priority: previousPriority },
    next: { status: payload.status ?? ticket.status, priority: ticket.priority },
    ...auditContext,
  });

  return ticket.toSafeJSON();
}

export async function addHelpComment(ticketId, actor, permissions, payload, auditContext = {}) {
  const ticket = await loadTicket(ticketId);
  if (!(await canViewTicket(actor, ticket, permissions))) {
    throwError('You do not have permission to comment on this ticket.', 403);
  }
  if (ticket.status === 'closed' || ticket.status === 'resolved') {
    throwError('This ticket is closed and cannot accept comments.', 400);
  }

  const comment = await HelpComment.create({
    ticketId: ticket._id,
    userId: actor._id,
    body: payload.body,
  });
  await comment.populate(HELP_COMMENT_POPULATE);

  const creatorId = getCreatorId(ticket);
  const actorId = actor._id.toString();
  const ticketLinkId = ticket._id.toString();
  const commentMetadata = { ticketId: ticketLinkId, commentId: comment._id.toString() };

  if (creatorId && creatorId !== actorId) {
    await createNotification({
      userId: creatorId,
      type: 'help.comment',
      title: 'New reply on your ticket',
      body: `${actor.name} commented on "${ticket.title}".`,
      link: `/employee/help/${ticketLinkId}`,
      metadata: commentMetadata,
    });
  }

  if (creatorId) {
    const stakeholderTitle =
      creatorId === actorId ? 'Employee replied on help ticket' : 'New comment on help ticket';
    await notifyHelpStakeholders({
      creatorId,
      actorId,
      type: 'help.comment',
      title: stakeholderTitle,
      body: `${actor.name} commented on "${ticket.title}".`,
      ticketId: ticketLinkId,
      metadata: commentMetadata,
    });
  }

  auditLog('help_ticket_comment_added', {
    userId: actor._id.toString(),
    ticketId: ticket._id.toString(),
    commentId: comment._id.toString(),
    next: { commentId: comment._id.toString(), bodyLength: (comment.body ?? '').length },
    ...auditContext,
  });

  return comment.toSafeJSON();
}

export async function deleteHelpTicket(ticketId, actor, permissions, auditContext = {}) {
  const ticket = await loadTicket(ticketId);
  // Managers/admins via canManageTicket; plus the creator may roll back
  // their own still-open ticket (e.g. EmployeeHelp deletes the ticket when
  // every attachment upload fails). Non-open tickets are staff-owned work
  // in progress and stay protected from creator delete.
  const isCreatorRollback =
    getCreatorId(ticket) === actor._id.toString() && ticket.status === 'open';
  if (!isCreatorRollback && !(await canManageTicket(actor, ticket, permissions))) {
    throwError('You are not authorized to delete this ticket.', 403);
  }

  const attachments = await HelpAttachment.find({ ticketId: ticket._id }).select('s3Key');
  await deleteS3Objects(attachments.map((a) => a.s3Key));

  await HelpAttachment.deleteMany({ ticketId: ticket._id });
  await HelpComment.deleteMany({ ticketId: ticket._id });
  await HelpTicket.findByIdAndDelete(ticket._id);

  auditLog('help_ticket_deleted', {
    userId: actor._id.toString(),
    ticketId: ticket._id.toString(),
    previous: {
      title: ticket.title ?? null,
      status: ticket.status ?? null,
      priority: ticket.priority ?? null,
    },
    ...auditContext,
  });
}

export async function deleteHelpComment(ticketId, commentId, actor, permissions, auditContext = {}) {
  const ticket = await loadTicket(ticketId);
  if (!(await canViewTicket(actor, ticket, permissions))) {
    throwError('You do not have permission to delete this comment.', 403);
  }

  if (!mongoose.isValidObjectId(commentId)) {
    throwError('Comment not found.', 404);
  }

  const comment = await HelpComment.findOne({ _id: commentId, ticketId: ticket._id });
  if (!comment) {
    throwError('Comment not found.', 404);
  }

  const commentCreatorId = comment.userId?.toString?.() ?? comment.userId?._id?.toString?.() ?? null;
  if (commentCreatorId !== actor._id.toString() && !hasPermission(permissions, PERMISSIONS.HELP_MANAGE)) {
    throwError('You can only delete your own comments.', 403);
  }

  const commentAttachments = await HelpAttachment.find({ commentId: comment._id }).select('s3Key');
  await deleteS3Objects(commentAttachments.map((a) => a.s3Key));

  await HelpAttachment.deleteMany({ commentId: comment._id });
  await HelpComment.findByIdAndDelete(comment._id);

  auditLog('help_ticket_comment_deleted', {
    userId: actor._id.toString(),
    ticketId: ticket._id.toString(),
    commentId: comment._id.toString(),
    ...auditContext,
  });
}
