import { readFileSync, writeFileSync } from 'fs';
const p = 'D:/GRUBPAC WEB APPS/Grubpac-attendance_webapp/Grubpac-attendance-webapp/client/src/pages/admin/AdminOfficeSettings.jsx';
const raw = readFileSync(p, 'utf8');
const t = raw.replace(/\r\n/g, '\n');

const changes = [
  [
    `  autoCheckout: { enabled: true, officeTime: '23:59', wfhTime: '06:00' },`,
    `  autoCheckout: {
    enabled: true,
    office: { day: 'same', time: '23:59' },
    wfh: { day: 'next', time: '06:00' },
  },`,
  ],
  [
    `            autoCheckout: settings.autoCheckout ? { enabled: settings.autoCheckout.enabled ?? true, officeTime: settings.autoCheckout.officeTime ?? '23:59', wfhTime: settings.autoCheckout.wfhTime ?? '06:00' } : { enabled: true, officeTime: '23:59', wfhTime: '06:00' },`,
    `            autoCheckout: settings.autoCheckout
              ? {
                  enabled: settings.autoCheckout.enabled ?? true,
                  office: settings.autoCheckout.office ?? { day: 'same', time: '23:59' },
                  wfh: settings.autoCheckout.wfh ?? { day: 'next', time: '06:00' },
                }
              : { enabled: true, office: { day: 'same', time: '23:59' }, wfh: { day: 'next', time: '06:00' } },`,
  ],
  [
    `              <span>Enabled: {form.autoCheckout?.enabled ? 'Yes' : 'No'}</span>
              <span>Office: {form.autoCheckout?.officeTime ?? '23:59'}</span>
              <span>WFH: {form.autoCheckout?.wfhTime ?? '06:00'}</span>`,
    `              <span>Enabled: {form.autoCheckout?.enabled ? 'Yes' : 'No'}</span>
              <span>Office: {form.autoCheckout?.office ? \`\${form.autoCheckout.office.day === 'next' ? 'Next day' : 'Same day'} at \${formatTimeDisplay(form.autoCheckout.office.time) ?? form.autoCheckout.office.time}\` : 'Same day at 11:59 PM'}</span>
              <span>WFH: {form.autoCheckout?.wfh ? \`\${form.autoCheckout.wfh.day === 'next' ? 'Next day' : 'Same day'} at \${formatTimeDisplay(form.autoCheckout.wfh.time) ?? form.autoCheckout.wfh.time}\` : 'Next day at 6:00 AM'}</span>`,
  ],
  [
    `import TimeField from '../../components/TimeField.jsx';`,
    `import TimeField, { formatTimeDisplay } from '../../components/TimeField.jsx';`,
  ],
];

let ok = true;
for (const [oldS, newS] of changes) {
  if (!t.includes(oldS)) {
    console.log('NOT FOUND:', oldS.slice(0, 60));
    ok = false;
  }
}
if (ok) {
  let out = t;
  for (const [oldS, newS] of changes) out = out.replace(oldS, newS);
  writeFileSync(p, out.replace(/\n/g, '\r\n'));
  console.log('AdminOfficeSettings.jsx patched');
} else {
  console.log('Aborted due to missing matches');
}
