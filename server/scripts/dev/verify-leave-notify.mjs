import { sendEmail, renderLeaveManagerEmail, renderLeaveApplicantEmail } from '../../src/services/emailService.js';
import { sendSms, isSmsConfigured } from '../../src/services/smsService.js';

const apiOrigin = process.env.API_ORIGIN || process.env.CLIENT_ORIGIN || 'http://localhost:5173';
const testEmail = process.env.TEST_EMAIL || 'jha.piyush@grubpac.com';
const testPhone = process.env.TEST_PHONE || '8149221218';

console.log('SMS configured:', isSmsConfigured());
console.log('Using recipient email:', testEmail, '| phone:', testPhone);
console.log('Links use API_ORIGIN:', apiOrigin, '(set API_ORIGIN in .env to the real API host for production)\n');

const requestId = '000000000000000000000002';
const approvalUrl = `${apiOrigin}/api/leave/decision-link?request=${requestId}&action=approve&token=demoapprovetoken`;
const rejectUrl = `${apiOrigin}/api/leave/decision-link?request=${requestId}&action=reject&token=demorejecttoken`;

// A) Manager notification — same as the leave flow sends
const { subject, html, text } = renderLeaveManagerEmail({
  requesterName: 'Emp Test',
  leaveTypeName: 'Casual Leave',
  reason: 'Family function',
  dateText: '27 Aug 2026',
  timeText: 'Full day',
  withActions: true,
  approvalUrl,
  rejectUrl,
});
console.log('--- MANAGER EMAIL ---');
const e1 = await sendEmail({ to: testEmail, subject, html, text, tag: 'leave-manager' });
console.log('result:', e1);

console.log('\n--- MANAGER SMS ---');
const smsText = `Emp Test applied for Casual Leave (27 Aug 2026). Approve: ${approvalUrl} | Reject: ${rejectUrl}`;
const s1 = await sendSms({ to: testPhone, message: smsText });
console.log('result:', s1);

// B) Applicant notification on decision — same path the leave flow uses
console.log('\n--- APPLICANT EMAIL + SMS ---');
const decision = { subject: 'Leave request approved: Casual Leave', html: '', text: '' };
const appr = renderLeaveApplicantEmail({
  leaveTypeName: 'Casual Leave',
  status: 'approved',
  remarks: '',
  dateText: '27 Aug 2026',
  timeText: 'Full day',
});
const e2 = await sendEmail({ to: testEmail, subject: appr.subject, html: appr.html, text: appr.text, tag: 'leave-applicant' });
console.log('applicant email result:', e2);
const s2 = await sendSms({ to: testPhone, message: `Your Casual Leave (27 Aug 2026) has been approved.` });
console.log('applicant sms result:', s2);

console.log('\nDONE');
process.exit(0);

