import { User } from '../models/User.js';
import { Role } from '../models/Role.js';
import { SYSTEM_ROLE_SLUGS } from '../../../shared/permissions.js';
import { auditLogSync } from '../utils/auditLog.js';
import { logError } from '../utils/logger.js';
import { acquireJobLock, releaseJobLock } from '../utils/jobLock.js';
import { startOfDayIST } from '../utils/istDate.js';

/**
 * Daily sweep: employees whose ending date is before today become inactive
 * automatically. Admin-role holders are never touched (deactivating the
 * system account would lock everyone out) and are reported separately.
 *
 * Idempotent: only currently-active users past their end date are flipped,
 * so re-runs process nothing new.
 */
export async function runEmploymentEndJob(now = new Date()) {
  const lock = await acquireJobLock('employment-end', { ttlMs: 240_000 });
  if (!lock.acquired) {
    return { skipped: true, reason: lock.reason };
  }
  try {
    const todayStart = startOfDayIST(now);
    const candidates = await User.find({
      isActive: true,
      endingDate: { $ne: null, $lt: todayStart },
    })
      .select('_id email name employeeCode endingDate roleId role')
      .lean();

    if (candidates.length === 0) {
      return { processed: 0, skippedAdmins: 0, runAt: now.toISOString() };
    }

    const adminRole = await Role.findOne({ slug: SYSTEM_ROLE_SLUGS.ADMIN }).select('_id').lean();
    const adminRoleId = adminRole?._id?.toString() ?? null;

    let processed = 0;
    let skippedAdmins = 0;
    const deactivatedIds = [];
    for (const candidate of candidates) {
      const roleId = candidate.roleId?._id?.toString?.() ?? candidate.roleId?.toString?.() ?? null;
      if ((adminRoleId && roleId === adminRoleId) || candidate.role === 'admin') {
        skippedAdmins += 1;
        continue;
      }
      try {
        await User.updateOne({ _id: candidate._id }, { $set: { isActive: false } });
        await auditLogSync('employee_auto_deactivated', {
          userId: candidate._id.toString(),
          email: candidate.email ?? undefined,
          endingDate:
            candidate.endingDate instanceof Date
              ? candidate.endingDate.toISOString()
              : candidate.endingDate ?? undefined,
          reason: 'ending_date_passed',
        });
        processed += 1;
        deactivatedIds.push(candidate._id.toString());
      } catch (error) {
        logError('employment_end_failed', {
          userId: candidate._id.toString(),
          error: error.message,
        });
      }
    }

    return { processed, skippedAdmins, deactivatedIds, runAt: now.toISOString() };
  } finally {
    await releaseJobLock('employment-end', lock.lockId).catch(() => {});
  }
}
