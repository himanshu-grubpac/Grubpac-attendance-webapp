/**
 * Compare all catalog slugs (182) vs server route/controller/service wiring.
 * Summarize 72 catalog rows as wired | partial | missing.
 *
 * Run from repo root: node server/scripts/dev/audit-rbac-coverage.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PERMISSIONS } from '../../../shared/permissions.js';
import { PERMISSION_CATALOG, getAllCatalogSlugs, slugsFromRow } from '../../../shared/permissionCatalog.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = join(__dirname, '../../..');
const SERVER_SRC = join(REPO_ROOT, 'server/src');
const CLIENT_SRC = join(REPO_ROOT, 'client/src');

/** Client-only slugs (nav/route guards, no dedicated API). */
const CLIENT_ONLY_SLUGS = new Set([
  'portal.admin.r',
  'portal.employee.r',
  'portal.switch.r',
  'dashboard.admin.r',
  'dashboard.employee.r',
  'employees.salary_column.r',
  'employees.stats.r',
  'attendance.warning_col.r',
  'attendance.log.r',
  'leave.calendar.r',
  'emp.dashboard.r',
  'emp.policy_summary.r',
  'ops.geofence.r',
  'ops.faq.r',
  'ops.guide.r',
  'table.columns.r',
  'table.columns.u',
]);

/** Slugs intentionally deferred (no separate API endpoint yet). */
const DEFERRED_SLUGS = new Set([
  'attendance.record.x0', // confirm-day — folded into x1 week confirm
  'ops.faq.x1', // FAQ reorder — client-only action
]);

/** slug → PERMISSIONS constant names (excludes legacy duplicate aliases for cleaner hits). */
const slugToKeys = new Map();
for (const [key, slug] of Object.entries(PERMISSIONS)) {
  if (!slugToKeys.has(slug)) slugToKeys.set(slug, []);
  slugToKeys.get(slug).push(key);
}

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (name === 'node_modules' || name === 'dist') continue;
      walk(full, acc);
    } else if (/\.(js|jsx|mjs)$/.test(name) && !/\.test\.(js|jsx)$/.test(name)) {
      acc.push(full);
    }
  }
  return acc;
}

function loadTexts(root) {
  const files = walk(root);
  const texts = new Map();
  for (const file of files) {
    texts.set(relative(REPO_ROOT, file), readFileSync(file, 'utf8'));
  }
  return texts;
}

function normPath(file) {
  return file.replace(/\\/g, '/');
}

function isGuardFile(file) {
  const p = normPath(file);
  return (
    p.includes('server/src/routes/') ||
    p.includes('server/src/controllers/') ||
    p.includes('server/src/middleware/auth.js') ||
    /Service\.js$/i.test(p) ||
    p.includes('server/src/services/')
  );
}

function findSlugRefs(slug, texts) {
  const keys = slugToKeys.get(slug) ?? [];
  const hits = new Set();

  for (const [file, text] of texts) {
    let matched = false;
    if (text.includes(`'${slug}'`) || text.includes(`"${slug}"`)) matched = true;
    for (const key of keys) {
      if (text.includes(`PERMISSIONS.${key}`)) {
        matched = true;
        break;
      }
    }
    if (matched) hits.add(file);
  }
  return [...hits];
}

function classifySlug(slug, serverTexts, clientTexts) {
  if (DEFERRED_SLUGS.has(slug)) return { status: 'wired', note: 'deferred-by-design' };

  const serverHits = findSlugRefs(slug, serverTexts);
  const clientHits = findSlugRefs(slug, clientTexts);
  const guardHits = serverHits.filter(isGuardFile);

  if (guardHits.length > 0) return { status: 'wired', files: guardHits };

  if (CLIENT_ONLY_SLUGS.has(slug) && clientHits.length > 0) {
    return { status: 'wired', note: 'client-only-gate', files: clientHits };
  }

  if (serverHits.length > 0) {
    return { status: 'partial', files: serverHits, note: 'server-ref-outside-guard' };
  }

  if (clientHits.length > 0) {
    return { status: 'partial', files: clientHits, note: 'client-only' };
  }

  return { status: 'missing', files: [] };
}

function rowStatus(slugResults) {
  const statuses = slugResults.map((s) => s.status);
  if (statuses.every((s) => s === 'wired')) return 'wired';
  if (statuses.every((s) => s === 'missing')) return 'missing';
  return 'partial';
}

function main() {
  const allSlugs = getAllCatalogSlugs();
  const serverTexts = loadTexts(SERVER_SRC);
  const clientTexts = loadTexts(CLIENT_SRC);

  const slugMap = new Map();
  for (const slug of allSlugs) {
    slugMap.set(slug, classifySlug(slug, serverTexts, clientTexts));
  }

  const wiredSlugs = [...slugMap.entries()].filter(([, v]) => v.status === 'wired').map(([k]) => k);
  const partialSlugs = [...slugMap.entries()].filter(([, v]) => v.status === 'partial');
  const missingSlugs = [...slugMap.entries()].filter(([, v]) => v.status === 'missing');

  const rows = [];
  for (const catalogRow of PERMISSION_CATALOG) {
    const slugs = slugsFromRow(catalogRow);
    const slugResults = slugs.map((slug) => ({ slug, ...slugMap.get(slug) }));
    rows.push({
      row: catalogRow.row,
      resource: catalogRow.resource,
      page: catalogRow.page,
      status: rowStatus(slugResults),
      slugs: slugResults,
    });
  }

  const rowCounts = { wired: 0, partial: 0, missing: 0 };
  for (const r of rows) rowCounts[r.status] += 1;

  console.log('=== RBAC COVERAGE AUDIT ===');
  console.log(`Total catalog slugs: ${allSlugs.length}`);
  console.log(`Wired slugs: ${wiredSlugs.length}/${allSlugs.length}`);
  console.log(`Partial slugs: ${partialSlugs.length}`);
  console.log(`Missing slugs: ${missingSlugs.length}`);
  console.log('');
  console.log(`72-row summary: wired=${rowCounts.wired} partial=${rowCounts.partial} missing=${rowCounts.missing}`);
  console.log('');

  console.log('--- 72-row matrix ---');
  for (const r of rows) {
    const slugSummary = r.slugs.map((s) => `${s.slug}:${s.status}`).join(', ');
    console.log(`${String(r.row).padStart(2)} | ${r.status.padEnd(7)} | ${r.resource} | ${slugSummary}`);
  }

  if (partialSlugs.length) {
    console.log('\n--- partial slugs ---');
    for (const [slug, info] of partialSlugs) {
      console.log(`  ${slug} — ${info.note ?? ''} ${(info.files ?? []).slice(0, 3).join(', ')}`);
    }
  }

  if (missingSlugs.length) {
    console.log('\n--- missing slugs ---');
    for (const [slug] of missingSlugs) console.log(`  ${slug}`);
    process.exitCode = 1;
  }
}

main();
