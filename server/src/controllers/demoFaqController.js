import mongoose from 'mongoose';
import { DemoFaqItem } from '../models/DemoFaqItem.js';
import {
  createDemoFaqSchema,
  updateDemoFaqSchema,
} from '../../../shared/validation/demoFaq.js';
import { auditLog } from '../utils/auditLog.js';

/**
 * Resolve the caller's role slug from the populated roleId document.
 * Falls back to legacy `user.role` field for backward compatibility.
 */
function resolveCallerRoleSlug(user) {
  const roleDoc = user.roleId && typeof user.roleId === 'object' ? user.roleId : null;
  return roleDoc?.slug ?? user.role ?? 'employee';
}

/**
 * GET /api/demo-faq
 * Returns active items whose visibleRoles includes the caller's role slug.
 * Sorted by sortOrder asc, then createdAt desc.
 */
export async function listForRole(req, res) {
  const roleSlug = resolveCallerRoleSlug(req.user);
  const items = await DemoFaqItem.find({
    isActive: true,
    visibleRoles: roleSlug,
  }).sort({ sortOrder: 1, createdAt: -1 });

  res.json({ items: items.map((item) => item.toSafeJSON()) });
}

/**
 * GET /api/demo-faq/manage
 * Returns ALL items (active + inactive) for the admin manage view.
 * Sorted by sortOrder asc, then createdAt desc.
 */
export async function listAll(req, res) {
  const items = await DemoFaqItem.find()
    .sort({ sortOrder: 1, createdAt: -1 });

  res.json({ items: items.map((item) => item.toSafeJSON()) });
}

/**
 * POST /api/demo-faq
 * Creates a new DemoFaqItem.
 */
export async function createItem(req, res) {
  const parsed = createDemoFaqSchema.parse(req.body);

  const item = await DemoFaqItem.create({
    ...parsed,
    createdBy: req.user._id,
  });

  auditLog('demo_faq_created', {
    adminId: req.user._id.toString(),
    itemId: item._id.toString(),
    type: item.type,
    title: item.title,
    visibleRoles: item.visibleRoles,
  });

  res.status(201).json({ item: item.toSafeJSON() });
}

/**
 * PUT /api/demo-faq/:id
 * Updates an existing DemoFaqItem.
 */
export async function updateItem(req, res) {
  const { id } = req.params;

  if (!mongoose.isValidObjectId(id)) {
    return res.status(404).json({ message: 'Item not found.' });
  }

  const parsed = updateDemoFaqSchema.parse(req.body);
  const item = await DemoFaqItem.findById(id);

  if (!item) {
    return res.status(404).json({ message: 'Item not found.' });
  }

  const previous = {
    type: item.type,
    title: item.title,
    content: item.content,
    contentKind: item.contentKind,
    visibleRoles: [...item.visibleRoles],
    sortOrder: item.sortOrder,
    isActive: item.isActive,
  };

  if (parsed.type !== undefined) item.type = parsed.type;
  if (parsed.title !== undefined) item.title = parsed.title;
  if (parsed.content !== undefined) item.content = parsed.content;
  if (parsed.contentKind !== undefined) item.contentKind = parsed.contentKind;
  if (parsed.visibleRoles !== undefined) item.visibleRoles = parsed.visibleRoles;
  if (parsed.sortOrder !== undefined) item.sortOrder = parsed.sortOrder;
  if (parsed.isActive !== undefined) item.isActive = parsed.isActive;

  await item.save();

  auditLog('demo_faq_updated', {
    adminId: req.user._id.toString(),
    itemId: item._id.toString(),
    previous,
    next: {
      type: item.type,
      title: item.title,
      content: item.content,
      contentKind: item.contentKind,
      visibleRoles: [...item.visibleRoles],
      sortOrder: item.sortOrder,
      isActive: item.isActive,
    },
  });

  res.json({ item: item.toSafeJSON() });
}

/**
 * DELETE /api/demo-faq/:id
 * Hard-deletes a DemoFaqItem (follows Department convention).
 */
export async function deleteItem(req, res) {
  const { id } = req.params;

  if (!mongoose.isValidObjectId(id)) {
    return res.status(404).json({ message: 'Item not found.' });
  }

  const item = await DemoFaqItem.findById(id);

  if (!item) {
    return res.status(404).json({ message: 'Item not found.' });
  }

  await item.deleteOne();

  auditLog('demo_faq_deleted', {
    adminId: req.user._id.toString(),
    itemId: id,
    type: item.type,
    title: item.title,
  });

  res.json({ message: 'Item deleted successfully.' });
}
