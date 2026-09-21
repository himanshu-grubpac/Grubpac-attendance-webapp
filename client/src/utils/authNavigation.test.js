import { describe, it, expect } from 'vitest';
import { PERMISSIONS } from '@shared/permissions.js';
import { isIntentionalAuthDeepLink, resolvePostLoginPath } from './authNavigation.js';

describe('authNavigation', () => {
  it('accepts email take-action deep links', () => {
    expect(
      isIntentionalAuthDeepLink('/admin/leave/approvals?decision=request&requestId=req1'),
    ).toBe(true);
    expect(
      isIntentionalAuthDeepLink('/admin/leave/comp-off?decision=request&requestId=co1'),
    ).toBe(true);
  });

  it('rejects stale module URLs saved during logout or session expiry', () => {
    expect(isIntentionalAuthDeepLink('/admin/users')).toBe(false);
    expect(isIntentionalAuthDeepLink('/admin/roles')).toBe(false);
    expect(isIntentionalAuthDeepLink('/employee/help')).toBe(false);
    expect(isIntentionalAuthDeepLink('/admin/users?status=true&role=hr')).toBe(false);
  });

  it('routes fresh logins to the role default unless the deep link is intentional', () => {
    const user = { permissions: [PERMISSIONS.PORTAL_ADMIN, PERMISSIONS.DASHBOARD_ADMIN] };
    expect(resolvePostLoginPath('/admin/users', user, 'admin')).toBe('/admin/dashboard');
    expect(
      resolvePostLoginPath(
        '/admin/leave/approvals?decision=request&requestId=req1',
        user,
        'admin',
      ),
    ).toBe('/admin/leave/approvals?decision=request&requestId=req1');
  });
});
