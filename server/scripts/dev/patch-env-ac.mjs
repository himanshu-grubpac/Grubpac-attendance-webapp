import { readFileSync, writeFileSync } from 'fs';
const p = 'D:/GRUBPAC WEB APPS/Grubpac-attendance_webapp/Grubpac-attendance-webapp/server/src/config/env.js';
const raw = readFileSync(p, 'utf8');
const t = raw.replace(/\r\n/g, '\n');
const oldStr = `    autoCheckout: {
      enabled: bool(process.env.AUTO_CHECKOUT_ENABLED ?? 'true'),
      officeTime: process.env.AUTO_CHECKOUT_OFFICE_TIME ?? '23:59',
      wfhTime: process.env.AUTO_CHECKOUT_WFH_TIME ?? '06:00',
    },`;
const newStr = `    autoCheckout: {
      enabled: bool(process.env.AUTO_CHECKOUT_ENABLED ?? 'true'),
      office: {
        day: process.env.AUTO_CHECKOUT_OFFICE_DAY ?? 'same',
        time: process.env.AUTO_CHECKOUT_OFFICE_TIME ?? '23:59',
      },
      wfh: {
        day: process.env.AUTO_CHECKOUT_WFH_DAY ?? 'next',
        time: process.env.AUTO_CHECKOUT_WFH_TIME ?? '06:00',
      },
    },`;
if (!t.includes(oldStr)) { console.log('NOT FOUND'); } else {
  writeFileSync(p, t.replace(oldStr, newStr).replace(/\n/g, '\r\n'));
  console.log('env patched');
}
