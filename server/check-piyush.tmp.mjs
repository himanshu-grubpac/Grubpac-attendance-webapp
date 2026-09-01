import { MongoClient } from 'mongodb';
const uri = 'mongodb+srv://admin:admin@cluster0.lnmo47k.mongodb.net/test?appName=attendance_web';
const c = new MongoClient(uri, { serverSelectionTimeoutMS: 15000 });
await c.connect();
const db = c.db('test');
const u = await db.collection('users').findOne({ email: 'piyushjhatkd@gmail.com' });
if (!u) { console.log('NOT FOUND'); process.exit(0); }
console.log(JSON.stringify({
  _id: u._id.toString(),
  name: u.name,
  email: u.email,
  role: u.role,
  roleId: u.roleId?.toString(),
  employeeCode: u.employeeCode,
  mobile: u.mobile,
  isActive: u.isActive,
  tokenVersion: u.tokenVersion,
  hasPasswordHash: Boolean(u.passwordHash),
  passwordHashPrefix: String(u.passwordHash ?? '').slice(0, 7),
  hasPin4: u.pin4Hash && u.pin4Hash !== 'null',
  hasPin6: u.pin6Hash && u.pin6Hash !== 'null',
  reportingManagerId: u.reportingManagerId?.toString?.() ?? null,
  department: u.department,
  departmentId: u.departmentId?.toString?.() ?? null,
  createdBy: u.createdBy?.toString?.() ?? null,
  createdAt: u.createdAt,
}, null, 2));
// How many attendance records + leave requests does this user have?
const ar = await db.collection('attendancerecords').countDocuments({ userId: u._id });
const lr = await db.collection('leaverequests').countDocuments({ userId: u._id });
console.log('attendance records:', ar, '| leave requests:', lr);
await c.close();
process.exit(0);
