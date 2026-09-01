import { MongoClient } from 'mongodb';
const uri = 'mongodb+srv://admin:admin@cluster0.lnmo47k.mongodb.net/test?appName=attendance_web';
const c = new MongoClient(uri, { serverSelectionTimeoutMS: 15000 });
await c.connect();
const db = c.db('test');
const allPending = await db.collection('leaverequests').countDocuments({ status: 'pending' });
console.log('TOTAL pending requests in DB:', allPending);
const reqs = await db.collection('leaverequests').find({ status: 'pending' }).sort({ createdAt: -1 }).limit(20).toArray();
for (const r of reqs) {
  const u = await db.collection('users').findOne({ _id: r.userId });
  const t = await db.collection('leavetypes').findOne({ _id: r.leaveTypeId });
  console.log(' ', r._id.toString(), '|', t?.code, '|', u?.email ?? r.userId?.toString?.(), '|', r.startDate.toISOString().slice(0,10), '->', r.endDate.toISOString().slice(0,10));
}
await c.close();
process.exit(0);
