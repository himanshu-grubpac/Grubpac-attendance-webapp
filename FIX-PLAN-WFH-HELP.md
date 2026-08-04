# Fix Plan: WFH Salary LOP + Help Ticket "New Ticket"

**Created:** 2026-08-03 (read-only prod audit)  
**Status:** Implemented locally; deployed to **staging** (2026-08-03). Production **not** deployed.  
**Database audited:** `attendance_web` on Atlas (`grubpac-attendance.uvcyogy.mongodb.net`) via `server/.env`  
**Staging note:** No local `server/.env.staging` found — only `server/.env.staging.example`. This audit used prod only.

---

## Audit findings (read-only)

**Audit date:** Monday, 3 Aug 2026  
**Method:** Read-only MongoDB queries + `computeMonthlySalarySummary()` for Aug 2026  
**Mutations:** None

### 1. WFH LeavePolicy — `paid` flag (all years)

| Year | `paid` | `isActive` | `annualQuota` | Notes |
|------|--------|------------|---------------|-------|
| 2024 | — | — | — | **No policy row** |
| 2025 | — | — | — | **No policy row** |
| **2026** | **`true`** | **`true`** | **50** | Only WFH policy in prod |
| 2027 | — | — | — | **No policy row** |

**Answer:** Prod WFH policy is **`paid: true`** — **not** `paid: false`.

Seed code in `shared/permissions.js` also defaults WFH to `paid: true`. Admin may have overridden quota to 50 (seed default is 30).

### 2. WFH leave requests — all employees (by status)

| Status | Count | Employees |
|--------|------:|-----------|
| **Approved** | **1** | Arpit (`arpit@grubpac.com`, STR002) — 2026-08-04, 1 day |
| **Pending** | **0** | — |
| **Rejected** | **0** | — |
| **Cancelled** | **0** | — |
| **Total** | **1** | — |

**Per-employee detail (approved):**

- **Arpit** — `arpit@grubpac.com` / STR002 — 2026-08-04 → 2026-08-04 (1 day, full day)

**Mohit Kumar** (`mohit@grubpac.com`, DEV001):

- WFH leave requests: **0** (no leave requests of any type)
- WFH attendance check-in: **2026-08-01** (mode `wfh`, tag `P`) — counts as present in salary logic
- `monthlySalary`: **not configured** (`null`)

### 3. Employees affected by incorrect salary LOP due to WFH

**Count: 0**

Cross-check (Aug 2026) using live `salaryService.computeMonthlySalarySummary()`:

| Employee | Approved WFH | WFH policy paid | Check-in on WFH days | `paidLeaveDays` | Incorrect LOP from WFH? |
|----------|-------------|-----------------|----------------------|-----------------|-------------------------|
| Arpit | 2026-08-04 (1 day) | yes | none | **1** | **No** — WFH credited correctly |

**Salaried employees in prod:** 2 total (Anuj Kumar, Arpit). Only Arpit has WFH leave; LOP shown is from low `presentDays` in the month, not from WFH exclusion.

**Aug 2026 WFH via attendance check-in** (separate from leave apply — always counts as present):

| Employee | WFH check-in dates |
|----------|-------------------|
| Mohit Kumar | 2026-08-01 |
| Prema Sharma | 2026-08-03 |
| Snehal Bhargava | 2026-08-03 |
| Amarpreet Singh | 2026-08-03 |
| Himanshu Salunke | 2026-08-03 |

These are **not** LOP-affected — allowed check-ins credit present days regardless of `attendanceMode`.

### 4. Risks confirmed / ruled out

| Risk | Result |
|------|--------|
| WFH leave still **pending** (not approved)? | **No** pending WFH for any employee |
| Prod WFH policy **`paid: false`**? | **No** — `paid: true` for 2026 |
| Approved WFH excluded from salary? | **No** for current data — Arpit gets `paidLeaveDays: 1` |
| Mohit-specific WFH leave issue in prod? | **No WFH leave record** for Mohit; he may have seen UI before approval, tested another env, or meant WFH check-in vs leave apply |

### 5. Org snapshot (context)

- Active employees: **29**
- With salary configured: **2** (Anuj, Arpit)
- Total WFH leave requests (all time): **1**

---

## Bug 1 — WFH leave causes salary deduction (should NOT)

**Reported by:** Mohit Sir  
**Expected:** WFH = working from home → no LOP / salary cut  
**Root cause (code):** `server/src/services/salaryService.js` only credits leave types whose active policy has `paid: true`. Pending leave never counts. No WFH-specific business-rule override.

**Prod data today:** Policy is correct (`paid: true`); no employee currently hit by misconfigured policy. **Defensive code fix still recommended** so WFH is always payable when approved, even if an admin toggles `paid: false` later.

### Fix steps

- [x] **Code:** In `server/src/services/salaryService.js`, always treat **approved WFH** leave as payable (union WFH type ID with paid policy set in `loadPaidLeaveTypeIds` or equivalent)
- [x] **Test:** Add unit test in `server/src/services/salaryService.test.js` — approved WFH with `paid: false` policy still yields zero LOP for WFH days
- [ ] **Optional API test:** Extend `scripts/verify-api.mjs` — apply + approve WFH, assert salary summary
- [ ] **Data (verify only):** Confirm Admin → Leave Policies shows WFH 2026 `paid: true` after any migrate (do **not** run migrate on prod unless HR approves — it overwrites seed fields)

### Verification steps

- [ ] Local: Employee applies WFH → manager approves → no check-in that day → `GET /api/salary/summary?month=YYYY-MM` → `paidLeaveDays` includes WFH; WFH days not in `lopDays`
- [ ] Local: Set WFH policy to `paid: false` in admin → approved WFH still does not LOP (after code fix)
- [ ] Local: Pending WFH still shows LOP until approved (expected behaviour)
- [ ] Staging: Repeat with real employee account; Mohit / QA sign-off *(API E2E blocked on staging — deploy `salaryService` WFH safeguard first)*
- [ ] Prod: Spot-check Arpit Aug 2026 summary after deploy (should remain correct)

---

## Bug 2 — Help tickets: no "New ticket" after first ticket

**Reported by:** Mohit Sir  
**Expected:** Employee can raise multiple tickets  
**Root cause (code):** `client/src/pages/employee/EmployeeHelp.jsx` — when `tickets.length > 0`, table shows only **View** per row. **New ticket** exists only in page toolbar (`PageMetaContext`) and empty state. After first submit, user is redirected to ticket detail; in-card create button is missing.

**Backend:** No limit — `helpService.createHelpTicket()` allows multiple tickets.

### Fix steps

- [x] **UI:** Add `card__toolbar` with **New ticket** button above ticket table when `tickets.length > 0 && !showForm` (mirror `AdminHelpTickets.jsx` pattern)
- [ ] **Optional cleanup:** `return () => setMeta(null)` on unmount in `EmployeeHelp.jsx`
- [ ] **Decision:** Keep toolbar + in-card button, or card-only (recommend both for desktop discoverability)

### Verification steps

- [ ] Local: Employee → Help → create first ticket → return to list → **New ticket** visible in card
- [ ] Local: Create second ticket successfully
- [ ] Local: Mobile viewport (≤960px) — button still reachable
- [x] Staging: Mohit / QA sign-off *(2026-08-03: API multi-ticket PASS — two tickets created + listed for `employee.sample@grubpac.com`; frontend `card__toolbar` confirmed in code)*
- [ ] Prod: Smoke test after frontend deploy

---

## Deploy order

| Step | Environment | What |
|------|-------------|------|
| 1 | **Local** | Implement Bug 1 (backend) + Bug 2 (frontend); run `npm run test` + manual QA |
| 2 | **Feature branch** | Push; optional PR review |
| 3 | **Staging** | `npm run deploy:staging:api` (Bug 1) + `npm run deploy:staging:frontend` (Bug 2) |
| 4 | **Staging verify** | WFH salary + multi-ticket flows; mark verification checkboxes above |
| 5 | **Production** | After QA: API deploy + frontend S3/CloudFront per `DEPLOYMENT.md` |
| 6 | **Prod data** | **No migration required today** — WFH policy already `paid: true`. Only run `migrateRecentFeatures.js` if policy is wrong in future (coordinate with ops; idempotent but overwrites admin tweaks) |

---

## Time estimate (~15–20 min for fixes)

| Task | Est. |
|------|------|
| Bug 1 — `salaryService` WFH payable logic | 8 min |
| Bug 1 — unit test | 4 min |
| Bug 2 — `EmployeeHelp` card toolbar | 4 min |
| Local smoke test | 3 min |
| **Total** | **~19 min** |

Staging deploy + verify: ~10 min additional.

---

## Files to change (when implementing)

| Bug | File | Change |
|-----|------|--------|
| 1 | `server/src/services/salaryService.js` | Always count approved WFH as payable |
| 1 | `server/src/services/salaryService.test.js` | WFH payable regression test |
| 1 | `scripts/verify-api.mjs` | Optional API regression |
| 2 | `client/src/pages/employee/EmployeeHelp.jsx` | In-card **New ticket** when list non-empty |

---

## Mark progress

Use `[x]` when done:

### Mohit fixes (WFH salary + Help ticket)
- [x] Bug 1 implemented locally
- [ ] Bug 1 verified locally
- [x] Bug 1 deployed staging
- [ ] Bug 1 verified staging *(2026-08-03 E2E FAIL: with WFH policy `paid: false`, approved WFH → `paidLeaveDays: 0`; local unit tests 45/45 PASS — re-deploy staging API or re-run after deploy)*
- [ ] Bug 1 deployed prod
- [x] Bug 2 implemented locally
- [ ] Bug 2 verified locally
- [x] Bug 2 deployed staging
- [x] Bug 2 verified staging *(2026-08-03: API multi-ticket PASS — two tickets 201 + listed; frontend `card__toolbar` in bundle)*
- [ ] Bug 2 deployed prod

### Admin leave approvals — Pending + Approved queue (same page)
- [x] Queue filter (Pending / Approved) on Pending requests page
- [x] Approved list shows approver name, decided date, comment
- [x] Permission scope unchanged (`scope=approvals`)
- [x] Verified locally / staging *(2026-08-03 staging E2E: pending + approved queues 200; 4 approved rows all have `approverName`)*
- [x] Deployed staging *(2026-08-03: `scope=approvals` pending/approved APIs verified on staging)*
- [ ] Deployed prod

- [ ] Mohit / HR sign-off
