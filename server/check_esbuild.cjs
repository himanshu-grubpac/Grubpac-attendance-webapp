const esbuild = require('D:/GRUBPAC WEB APPS/Grubpac-attendance_webapp/Grubpac-attendance-webapp/client/node_modules/vitest/node_modules/esbuild/lib/main.js');
const fs = require('fs');
const base = 'D:/GRUBPAC WEB APPS/Grubpac-attendance_webapp/Grubpac-attendance-webapp/client/';
const files = [
  'src/pages/admin/AdminLeaveApprovals.jsx',
  'src/App.jsx',
  'src/pages/employee/EmployeeDashboard.jsx',
  'src/context/ActionPopupContext.jsx',
  'src/services/api.js',
];
for (const f of files) {
  try {
    esbuild.transformSync(fs.readFileSync(base + f, 'utf8'), { loader: 'jsx', jsx: 'automatic' });
    console.log('OK  ' + f);
  } catch (e) {
    console.log('ERR ' + f + ': ' + e.message.split('\n').slice(0, 3).join(' | '));
  }
}
