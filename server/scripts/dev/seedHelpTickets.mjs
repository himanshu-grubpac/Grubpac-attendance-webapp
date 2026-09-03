import mongoose from 'mongoose';
import 'dotenv/config';

const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:60033/?replicaSet=testset';
const c = await mongoose.createConnection(uri, { serverSelectionTimeoutMS: 10000 }).asPromise();
const db = c.getClient().db(c.name);

const HelpTicket = db.collection('helptickets');
const HelpComment = db.collection('helpcomments');
const User = db.collection('users');

const users = await User.find({}, { _id: 1, name: 1, email: 1 }).limit(10).toArray();
if (users.length === 0) {
  console.error('No users found. Run the main seed first.');
  process.exit(1);
}
console.log(`Found ${users.length} users: ${users.map((u) => u.email).join(', ')}`);

const admin = users.find((u) => u.email === 'admin@grubpac.com') || users[0];
const employee = users.find((u) => u.email !== 'admin@grubpac.com') || users[1];

const tickets = [
  {
    title: 'Cannot login to the portal',
    category: 'Login',
    description: 'I am unable to login since this morning. It shows "Invalid credentials" even though I am using the correct password. I have tried resetting but the reset email never arrives.',
    priority: 'high',
    status: 'open',
    createdBy: employee._id,
    assignedTo: null,
  },
  {
    title: 'Attendance not marked for yesterday',
    category: 'Attendance',
    description: 'My attendance for 2026-09-01 was not auto-marked. I was present in the office the full day and my location was within the office geofence. Please check and update.',
    priority: 'medium',
    status: 'in_progress',
    createdBy: employee._id,
    assignedTo: admin._id,
  },
  {
    title: 'Leave balance not updated after approval',
    category: 'Leave',
    description: 'My casual leave request (CL) for August 28 was approved by my manager but the leave balance still shows the old count. It has been 3 days since approval.',
    priority: 'high',
    status: 'open',
    createdBy: employee._id,
    assignedTo: null,
  },
  {
    title: 'Salary slip not received for August',
    category: 'Salary',
    description: 'I have not received my salary slip for the month of August 2026. My colleagues have already received theirs. Please check and share the slip.',
    priority: 'medium',
    status: 'open',
    createdBy: employee._id,
    assignedTo: null,
  },
  {
    title: 'Unable to upload documents in leave request',
    category: 'Other',
    description: 'When I try to attach a medical certificate to my sick leave request, the file upload fails with a generic error. I have tried PDF and PNG both under 2MB.',
    priority: 'low',
    status: 'resolved',
    createdBy: employee._id,
    assignedTo: admin._id,
  },
  {
    title: 'Half-day leave option missing',
    category: 'Leave',
    description: 'The duration dropdown on the apply leave page no longer shows the half-day option. It only shows "Full day(s)". This was working last week.',
    priority: 'medium',
    status: 'open',
    createdBy: employee._id,
    assignedTo: null,
  },
  {
    title: 'Wrong geofence radius configured',
    category: 'Attendance',
    description: 'The office geofence radius seems too small. Even when I am sitting inside the office premises, the app says I am outside the allowed area. Please verify the radius setting.',
    priority: 'high',
    status: 'in_progress',
    createdBy: employee._id,
    assignedTo: admin._id,
  },
  {
    title: 'Password reset email not received',
    category: 'Login',
    description: 'I requested a password reset 2 hours ago but still have not received the email. I checked spam folder as well. My registered email is correct.',
    priority: 'low',
    status: 'closed',
    createdBy: employee._id,
    assignedTo: admin._id,
  },
  {
    title: 'Deduction shown incorrectly on payslip',
    category: 'Salary',
    description: 'My September payslip shows a deduction of ₹5000 for "Loss of Pay" but I was present all working days. This seems to be a calculation error.',
    priority: 'high',
    status: 'open',
    createdBy: employee._id,
    assignedTo: null,
  },
  {
    title: 'Request to update emergency contact',
    category: 'Other',
    description: 'I need to update my emergency contact number in the system. The employee profile page does not have an option to edit this field. Kindly assist.',
    priority: 'low',
    status: 'open',
    createdBy: employee._id,
    assignedTo: null,
  },
  {
    title: 'WFH auto-checkout triggered early',
    category: 'Attendance',
    description: 'I was working from home today and the system auto-checked me out at 5:30 PM instead of the configured 6:00 PM. I was actively using the system at that time.',
    priority: 'medium',
    status: 'open',
    createdBy: employee._id,
    assignedTo: null,
  },
  {
    title: 'Sick leave without prior notice',
    category: 'Leave',
    description: 'I fell sick suddenly yesterday and could not submit the leave request in advance. I need to backdate a sick leave for yesterday. Is there a process for this?',
    priority: 'medium',
    status: 'in_progress',
    createdBy: employee._id,
    assignedTo: admin._id,
  },
];

await HelpTicket.deleteMany({});
console.log('Cleared existing help tickets');

const result = await HelpTicket.insertMany(tickets);
console.log(`Inserted ${result.insertedCount} help tickets`);

const comments = [
  { ticketId: result.insertedIds[1], userId: admin._id, body: 'Looking into this. I can see your swipe-in was recorded but the auto-checkout logic did not run. Will fix manually.' },
  { ticketId: result.insertedIds[1], userId: employee._id, body: 'Thank you. Please let me know once it is updated.' },
  { ticketId: result.insertedIds[2], userId: admin._id, body: 'Checked the balance ledger. The deduction was applied on approval. Revising now.' },
  { ticketId: result.insertedIds[4], userId: admin._id, body: 'This was a known issue with the S3 bucket policy. It has been fixed. Please try uploading again.' },
  { ticketId: result.insertedIds[4], userId: employee._id, body: 'It works now. Thanks for the quick fix!' },
  { ticketId: result.insertedIds[6], userId: admin._id, body: 'Verified the geofence coordinates. The center point was off by ~200m. Corrected it.' },
  { ticketId: result.insertedIds[7], userId: admin._id, body: 'The reset email service was down for maintenance. Already resolved. Please try again.' },
  { ticketId: result.insertedIds[10], userId: admin._id, body: 'Checking the auto-checkout job logs. Will update you.' },
  { ticketId: result.insertedIds[11], userId: admin._id, body: 'You can submit a backdated request. I have enabled the admin exception flag for your account. Please resubmit.' },
];

await HelpComment.insertMany(comments);
console.log(`Inserted ${comments.length} comments`);

await c.close();
console.log('Done.');
