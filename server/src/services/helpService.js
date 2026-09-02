import mongoose from 'mongoose';
import { PERMISSIONS, hasPermission } from '../../../shared/permissions.js';
import { HelpTicket, HELP_TICKET_POPULATE } from '../models/HelpTicket.js';
import { HelpComment, HELP_COMMENT_POPULATE } from '../models/HelpComment.js';
import { HelpAttachment, HELP_ATTACHMENT_POPULATE } from '../models/HelpAttachment.js';
import { User, USER_POPULATE_FIELDS } from '../models/User.js';
import { Role } from '../models/Role.js';
import { createNotification } from './notificationService.js';
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
  return User.find({ isActive: true, roleId: { $in: roleIds } }).select('_id name');
}

export function canViewTicket(actor, ticket, permissions) {
  const actorId = actor._id.toString();
  const creatorId = getCreatorId(ticket);

  if (creatorId === actorId) return true;
  if (hasPermission(permissions, PERMISSIONS.HELP_MANAGE)) {
    if (hasPermission(permissions, PERMISSIONS.USERS_WRITE)) {
      return true;
    }
    const creatorDoc =
      ticket.createdBy && typeof ticket.createdBy === 'object' ? ticket.createdBy : null;
    const managerId = getManagerId(creatorDoc ?? { reportingManagerId: null });
    if (managerId === actorId) return true;
  }
  return false;
}

export function canManageTicket(actor, ticket, permissions) {
  if (!hasPermission(permissions, PERMISSIONS.HELP_MANAGE)) {
    return false;
  }

  if (hasPermission(permissions, PERMISSIONS.USERS_WRITE)) {
    return true;
  }

  const actorId = actor._id.toString();
  const creatorId = getCreatorId(ticket);
  if (creatorId === actorId) return false;

  const managerId = getManagerId(
    ticket.createdBy && typeof ticket.createdBy === 'object'
      ? ticket.createdBy
      : { reportingManagerId: null },
  );
  return managerId === actorId;
}

export async function createHelpTicket(actor, payload) {
  const ticket = await HelpTicket.create({
    title: payload.title,
    category: payload.category,
    description: payload.description,
    priority: payload.priority ?? 'medium',
    status: 'open',
    createdBy: actor._id,
  });

  await notifyOnTicketCreated(actor, ticket);

  auditLog('help_ticket_created', {
    userId: actor._id.toString(),
    ticketId: ticket._id.toString(),
    category: ticket.category,
    priority: ticket.priority,
  });

  return (await HelpTicket.findById(ticket._id).populate(HELP_TICKET_POPULATE)).toSafeJSON();
}

async function notifyOnTicketCreated(creator, ticket) {
  const link = `/employee/help/${ticket._id.toString()}`;
  const title = 'New help ticket';
  const body = `${creator.name} raised "${ticket.title}" (${ticket.category}).`;

  const notifiedIds = new Set();

  const creatorDoc = await loadCreator(creator._id);
  const managerId = getManagerId(creatorDoc);
  if (managerId) {
    await createNotification({
      userId: managerId,
      type: 'help.new',
      title,
      body,
      link: `/admin/help/team/${ticket._id.toString()}`,
      metadata: { ticketId: ticket._id.toString() },
    });
    notifiedIds.add(managerId);
  }

  const managers = await findUsersWithPermission(PERMISSIONS.HELP_MANAGE);
  await Promise.all(
    managers
      .filter((user) => !notifiedIds.has(user._id.toString()))
      .map((user) =>
        createNotification({
          userId: user._id,
          type: 'help.new',
          title,
          body,
          link: `/admin/help/tickets/${ticket._id.toString()}`,
          metadata: { ticketId: ticket._id.toString() },
        }),
      ),
  );

  await createNotification({
    userId: creator._id,
    type: 'help.created',
    title: 'Help ticket submitted',
    body: `Your ticket "${ticket.title}" was submitted and is open.`,
    link,
    metadata: { ticketId: ticket._id.toString() },
  });
}

export async function listHelpTickets(actor, permissions, query) {
  const filter = {};
  const scope = query.scope;

  if (scope === 'mine') {
    filter.createdBy = actor._id;
  } else if (scope === 'team') {
    if (!hasPermission(permissions, PERMISSIONS.HELP_MANAGE)) {
      throwError('You do not have permission to view team help tickets.', 403);
    }
    const directReports = await User.find({
      reportingManagerId: actor._id,
      isActive: true,
    }).select('_id');
    filter.createdBy = { $in: directReports.map((item) => item._id) };
  } else if (scope === 'all') {
    if (
      !hasPermission(permissions, PERMISSIONS.HELP_MANAGE) ||
      !hasPermission(permissions, PERMISSIONS.USERS_WRITE)
    ) {
      throwError('You do not have permission to view all help tickets.', 403);
    }
  } else {
    filter.createdBy = actor._id;
  }

  if (query.status) {
    filter.status = query.status;
  }

  const skip = (query.page - 1) * query.limit;
  const [tickets, total] = await Promise.all([
    HelpTicket.find(filter)
      .populate(HELP_TICKET_POPULATE)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(query.limit),
    HelpTicket.countDocuments(filter),
  ]);

  return {
    tickets: tickets.map((item) => item.toSafeJSON()),
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
  if (!canViewTicket(actor, ticket, permissions)) {
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

  return {
    ticket: ticket.toSafeJSON(),
    comments: comments.map((item) => ({
      ...item.toSafeJSON(),
      attachments: attachmentsByComment[item._id.toString()] ?? [],
    })),
    attachments: attachmentDocs.map((item) => item.toSafeJSON()),
  };
}

export async function updateHelpTicketStatus(ticketId, actor, permissions, payload) {
  const ticket = await loadTicket(ticketId);
  if (!canManageTicket(actor, ticket, permissions)) {
    throwError('You are not authorized to update this ticket.', 403);
  }

  const previousStatus = ticket.status;
  ticket.status = payload.status;

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
    await createNotification({
      userId: creatorId,
      type: 'help.status',
      title: 'Help ticket updated',
      body: `Your ticket "${ticket.title}" is now ${payload.status.replace('_', ' ')}.`,
      link: `/employee/help/${ticket._id.toString()}`,
      metadata: { ticketId: ticket._id.toString(), status: payload.status },
    });
  }

  auditLog('help_ticket_status_updated', {
    userId: actor._id.toString(),
    ticketId: ticket._id.toString(),
    previousStatus,
    status: payload.status,
  });

  return ticket.toSafeJSON();
}

export async function addHelpComment(ticketId, actor, permissions, payload) {
  const ticket = await loadTicket(ticketId);
  if (!canViewTicket(actor, ticket, permissions)) {
    throwError('You do not have permission to comment on this ticket.', 403);
  }

  const comment = await HelpComment.create({
    ticketId: ticket._id,
    userId: actor._id,
    body: payload.body,
  });
  await comment.populate(HELP_COMMENT_POPULATE);

  const creatorId = getCreatorId(ticket);
  const actorId = actor._id.toString();
  const linkForCreator = `/employee/help/${ticket._id.toString()}`;

  if (creatorId && creatorId !== actorId) {
    await createNotification({
      userId: creatorId,
      type: 'help.comment',
      title: 'New reply on your ticket',
      body: `${actor.name} commented on "${ticket.title}".`,
      link: linkForCreator,
      metadata: { ticketId: ticket._id.toString(), commentId: comment._id.toString() },
    });
  } else if (creatorId === actorId) {
    const creatorDoc = await loadCreator(creatorId);
    const managerId = getManagerId(creatorDoc);
    const staffLink = `/admin/help/tickets/${ticket._id.toString()}`;

    if (managerId) {
      await createNotification({
        userId: managerId,
        type: 'help.comment',
        title: 'Employee replied on help ticket',
        body: `${actor.name} added a comment on "${ticket.title}".`,
        link: `/admin/help/team/${ticket._id.toString()}`,
        metadata: { ticketId: ticket._id.toString(), commentId: comment._id.toString() },
      });
    }

    const managers = await findUsersWithPermission(PERMISSIONS.HELP_MANAGE);
    await Promise.all(
      managers
        .filter((user) => user._id.toString() !== managerId && user._id.toString() !== actorId)
        .map((user) =>
          createNotification({
            userId: user._id,
            type: 'help.comment',
            title: 'New comment on help ticket',
            body: `${actor.name} commented on "${ticket.title}".`,
            link: staffLink,
            metadata: { ticketId: ticket._id.toString(), commentId: comment._id.toString() },
          }),
        ),
    );
  }

  auditLog('help_ticket_comment_added', {
    userId: actor._id.toString(),
    ticketId: ticket._id.toString(),
    commentId: comment._id.toString(),
  });

  return comment.toSafeJSON();
}

export async function deleteHelpTicket(ticketId, actor, permissions) {
  const ticket = await loadTicket(ticketId);
  if (!canManageTicket(actor, ticket, permissions)) {
    throwError('You are not authorized to delete this ticket.', 403);
  }

  await HelpAttachment.deleteMany({ ticketId: ticket._id });
  await HelpComment.deleteMany({ ticketId: ticket._id });
  await HelpTicket.findByIdAndDelete(ticket._id);

  auditLog('help_ticket_deleted', {
    userId: actor._id.toString(),
    ticketId: ticket._id.toString(),
  });
}

export async function deleteHelpComment(ticketId, commentId, actor, permissions) {
  const ticket = await loadTicket(ticketId);
  if (!canViewTicket(actor, ticket, permissions)) {
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

  await HelpAttachment.deleteMany({ commentId: comment._id });
  await HelpComment.findByIdAndDelete(comment._id);

  auditLog('help_ticket_comment_deleted', {
    userId: actor._id.toString(),
    ticketId: ticket._id.toString(),
    commentId: comment._id.toString(),
  });
}
