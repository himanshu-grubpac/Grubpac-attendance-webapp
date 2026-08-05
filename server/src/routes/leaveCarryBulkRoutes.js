import { Router } from 'express';
import multer from 'multer';
import { PERMISSIONS } from '../../../shared/permissions.js';
import { requirePermission } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import {
  downloadCarryAuditReport,
  downloadCarryBulkTemplate,
  uploadCarryBulk,
} from '../controllers/leaveCarryBulkController.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    const allowed =
      file.mimetype.includes('spreadsheet') ||
      file.mimetype.includes('excel') ||
      file.originalname.endsWith('.xlsx') ||
      file.originalname.endsWith('.xls');
    if (!allowed) {
      return cb(new Error('Only Excel files are allowed.'));
    }
    return cb(null, true);
  },
});

const router = Router();

router.get(
  '/carry-bulk/template',
  requirePermission(PERMISSIONS.LEAVE_ADJUST_BALANCES),
  asyncHandler(downloadCarryBulkTemplate),
);

router.get(
  '/carry-bulk/audit-report',
  requirePermission(PERMISSIONS.LEAVE_ADJUST_BALANCES),
  asyncHandler(downloadCarryAuditReport),
);

router.post(
  '/carry-bulk/upload',
  requirePermission(PERMISSIONS.LEAVE_ADJUST_BALANCES),
  upload.single('file'),
  asyncHandler(uploadCarryBulk),
);

export default router;
