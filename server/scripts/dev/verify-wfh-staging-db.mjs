/**
 * Staging-only MongoDB verification for WFH paid/salary state.
 * Reads URI from samconfig.staging.toml — never prod.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadStagingUri() {
  const toml = readFileSync(resolve(__dirname, '../../samconfig.staging.toml'), 'utf8');
  const m = toml.match(/mongodb\+srv:\/\/[^\\"]+attendance-staging[^\\"]+/);
  if (!m) throw new Error('Staging MongoDbUri not found in samconfig.staging.toml');
  return m[0];
}

function redactUri(uri) {
  return uri.replace(/:([^:@/]+)@/, ':***@');
}

async function connectStaging() {
  const srvUri = loadStagingUri();
  try {
    await mongoose.connect(srvUri, { serverSelectionTimeoutMS: 10000 });
    return { mode: 'srv', uri: redactUri(srvUri) };
  } catch (srvErr) {
    // Node on Windows may fail SRV lookup even when shards resolve — use direct hosts.
    const userPass = srvUri.match(/mongodb\+srv:\/\/([^@]+)@/)[1];
    const directUri =
      `mongodb://${userPass}@ac-fnycnlh-shard-00-00.ivyl6lu.mongodb.net:27017,` +
      `ac-fnycnlh-shard-00-01.ivyl6lu.mongodb.net:27017,` +
      `ac-fnycnlh-shard-00-02.ivyl6lu.mongodb.net:27017/attendance_web` +
      '?ssl=true&authSource=admin&replicaSet=atlas-fnycnlh-shard-0&appName=attendance-staging';
    await mongoose.connect(directUri, { serverSelectionTimeoutMS: 15000 });
    return { mode: 'direct', uri: redactUri(directUri), srvError: srvErr.message };
  }
}

async function main() {
  const conn = await connectStaging();
  console.log('Connected via:', conn.mode, conn.uri);
  if (conn.srvError) console.log('SRV fallback reason:', conn.srvError);

  const db = mongoose.connection.db;
  const year = new Date().getFullYear();

  const wfhType = await db.collection('leavetypes').findOne({ code: 'WFH' });

  const policies = await db
    .collection('leavepolicies')
    .aggregate([
      { $lookup: { from: 'leavetypes', localField: 'leaveTypeId', foreignField: '_id', as: 'lt' } },
      { $unwind: '$lt' },
      { $match: { 'lt.code': 'WFH' } },
      {
        $project: {
          year: 1,
          paid: 1,
          isActive: 1,
          annualQuota: 1,
          leaveTypeCode: '$lt.code',
        },
      },
      { $sort: { year: -1 } },
    ])
    .toArray();

  let approvedWfh = [];
  if (wfhType) {
    approvedWfh = await db
      .collection('leaverequests')
      .find({ leaveTypeId: wfhType._id, status: 'approved' })
      .sort({ startDate: -1 })
      .limit(20)
      .toArray();
  }

  const users = await db
    .collection('users')
    .find({
      $or: [
        { name: { $regex: 'mohit', $options: 'i' } },
        { email: { $regex: 'mohit|test|sample|staging', $options: 'i' } },
      ],
    })
    .project({ name: 1, email: 1, monthlySalary: 1, salaryEffectiveFrom: 1, isActive: 1 })
    .limit(20)
    .toArray();

  const userIds = [...new Set(approvedWfh.map((r) => r.userId.toString()))];
  const userMap = {};
  if (userIds.length) {
    const udocs = await db
      .collection('users')
      .find({ _id: { $in: userIds.map((id) => new mongoose.Types.ObjectId(id)) } })
      .project({ name: 1, email: 1, monthlySalary: 1 })
      .toArray();
    for (const u of udocs) userMap[u._id.toString()] = u;
  }

  const paidPolicies = await db
    .collection('leavepolicies')
    .find({ isActive: true, paid: true, year })
    .toArray();
  const paidIds = new Set(paidPolicies.map((p) => p.leaveTypeId.toString()));
  const currentWfhPolicy = policies.find((p) => p.year === year);

  const salaryUsers = users.filter((u) => u.monthlySalary > 0);
  let transfers = [];
  if (salaryUsers.length) {
    transfers = await db
      .collection('salarytransfers')
      .find({ userId: { $in: salaryUsers.map((u) => u._id) } })
      .sort({ periodKey: -1 })
      .limit(10)
      .toArray();
  }

  const totalApprovedWfh = wfhType
    ? await db.collection('leaverequests').countDocuments({
        leaveTypeId: wfhType._id,
        status: 'approved',
      })
    : 0;

  const report = {
    connection: conn,
    cluster: 'attendance-staging.ivyl6lu.mongodb.net',
    database: 'attendance_web',
    wfhLeaveType: wfhType
      ? { id: wfhType._id.toString(), code: wfhType.code, name: wfhType.name, isActive: wfhType.isActive }
      : null,
    wfhPolicies: policies.map((p) => ({
      year: p.year,
      paid: p.paid,
      isActive: p.isActive,
      annualQuota: p.annualQuota,
    })),
    currentYearWfhPolicyPaid: currentWfhPolicy?.paid ?? null,
    approvedWfhCount: totalApprovedWfh,
    recentApprovedWfh: approvedWfh.map((r) => ({
      userId: r.userId.toString(),
      userName: userMap[r.userId.toString()]?.name,
      userEmail: userMap[r.userId.toString()]?.email,
      startDate: r.startDate,
      endDate: r.endDate,
      days: r.days,
      halfDay: r.halfDay ?? null,
      decidedAt: r.decidedAt,
    })),
    mohitOrTestUsers: users.map((u) => ({
      id: u._id.toString(),
      name: u.name,
      email: u.email,
      monthlySalary: u.monthlySalary,
      salaryEffectiveFrom: u.salaryEffectiveFrom,
      isActive: u.isActive,
    })),
    salaryTransfers: transfers.map((t) => ({
      userId: t.userId.toString(),
      periodKey: t.periodKey,
      amount: t.amount,
      status: t.status,
    })),
    salaryLogic: {
      year,
      wfhInPaidPolicySetOnly: wfhType ? paidIds.has(wfhType._id.toString()) : false,
      wfhInPaidTypeIdsWithSafeguard: !!wfhType,
      explanation:
        'unionWfhLeaveTypeId always adds WFH leaveTypeId to paid set regardless of LeavePolicy.paid',
    },
    verdict: {
      wfhWouldBePaidWithCurrentCode: !!wfhType,
      wfhWouldBePaidWithoutSafeguard: currentWfhPolicy?.paid === true,
      mismatchIfPolicyUnpaidButSafeguardDeployed:
        currentWfhPolicy?.paid === false && !!wfhType,
    },
  };

  console.log(JSON.stringify(report, null, 2));
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: err.message }));
  process.exit(1);
});
