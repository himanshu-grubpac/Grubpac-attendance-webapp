import { Router } from 'express';
import {
  getTablePreference,
  updateTablePreference,
  deleteTablePreference,
  getAvailableColumns,
} from '../controllers/tablePreferenceController.js';
import { authenticate } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const router = Router();

router.use(authenticate);

router.get('/tables/:tableKey', asyncHandler(getTablePreference));
router.put('/tables/:tableKey', asyncHandler(updateTablePreference));
router.delete('/tables/:tableKey', asyncHandler(deleteTablePreference));
router.get('/tables/:tableKey/columns', asyncHandler(getAvailableColumns));

export default router;
