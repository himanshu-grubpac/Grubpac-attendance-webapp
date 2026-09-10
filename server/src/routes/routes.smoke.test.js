import assert from 'node:assert/strict';
import test from 'node:test';

/**
 * Route-module smoke test: importing every router must not throw.
 *
 * Rationale: a missing import binding inside a route file (e.g. a handler
 * referenced but never imported) is invisible to `node --check` and to all
 * service-level tests, yet crashes the entire server on boot (every /api/*
 * becomes a 502). This test fails fast instead.
 */
test('all route modules import without throwing', async () => {
  const modules = await Promise.all([
    import('./adminRoutes.js'),
    import('./attendanceRoutes.js'),
    import('./authRoutes.js'),
    import('./compOffRoutes.js'),
    import('./demoFaqRoutes.js'),
    import('./helpRoutes.js'),
    import('./leaveCarryBulkRoutes.js'),
    import('./leaveRoutes.js'),
    import('./notificationRoutes.js'),
    import('./salaryRoutes.js'),
    import('./tablePreferenceRoutes.js'),
  ]);
  for (const mod of modules) {
    assert.equal(typeof mod.default, 'function', 'router modules must default-export the router');
  }
});
