import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import 'dotenv/config';

/**
 * Seed ~60 additional realistic employees (spread across all departments) with
 * attendance records in the current + past weeks so the admin weekly grid has
 * enough rows to exercise scroll pagination.
 */

const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:60033/?replicaSet=testset';
const c = await mongoose.createConnection(uri, { serverSelectionTimeoutMS: 10000 }).asPromise();
const db = c.getClient().db(c.name);

const OFFICE = { lat: 28.647284, lng: 77.202835, radius: 5000 };
const HOME = { lat: 28.5943, lng: 77.3089 };
const IST_MS = 5.5 * 60 * 60 * 1000;

function toKey(date) {
  const d = new Date(date.getTime() + IST_MS);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}
function fromKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12, 0, 0, 0) - IST_MS);
}
function addDays(key, n) {
  const d = fromKey(key);
  d.setUTCDate(d.getUTCDate() + n);
  return toKey(d);
}
function weekday(key) {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Kolkata', weekday: 'short' }).format(fromKey(key));
}
function rand(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

const depts = await db.collection('departments').find({}).toArray();
const roles = await db.collection('roles').find({}).toArray();
const employeeRole = roles.find((r) => r.slug === 'employee') || roles.find((r) => r.name === 'Employee');

const passwordHash = await bcrypt.hash('Employee@12345', 10);

const firstNames = [
  'Amit', 'Rahul', 'Priya', 'Sneha', 'Vikram', 'Ananya', 'Rohan', 'Divya', 'Karan', 'Pooja',
  'Arjun', 'Meera', 'Sanjay', 'Kavita', 'Nikhil', 'Ishita', 'Rajat', 'Tanvi', 'Suresh', 'Neha',
  'Mohit', 'Ritika', 'Gaurav', 'Shreya', 'Varun', 'Anjali', 'Deepak', 'Pallavi', 'Harsh', 'Simran',
  'Aditya', 'Naina', 'Kunal', 'Sakshi', 'Ravi', 'Manisha', 'Aakash', 'Shivani', 'Naveen', 'Richa',
  'Yash', 'Kirti', 'Abhishek', 'Swati', 'Manav', 'Jyoti', 'Rakesh', 'Aishwarya', 'Pranav', 'Shalini',
  'Tarun', 'Vidya', 'Sachin', 'Renu', 'Hemant', 'Garima', 'Nitin', 'Preeti', 'Avinash', 'Sonal',
];
const lastNames = [
  'Sharma', 'Verma', 'Gupta', 'Singh', 'Kumar', 'Patel', 'Reddy', 'Nair', 'Iyer', 'Mehta',
  'Joshi', 'Bose', 'Chopra', 'Malhotra', 'Kapoor', 'Khanna', 'Saxena', 'Arora', 'Chawla', 'Dutta',
];
const designations = [
  'Software Engineer', 'Senior Engineer', 'UI Designer', 'Product Designer', 'Growth Manager',
  'Marketing Lead', 'Sales Executive', 'Strategy Analyst', 'Business Analyst', 'QA Engineer',
  'DevOps Engineer', 'Data Analyst', 'Content Strategist', 'Brand Designer', 'Account Manager',
];
const deptCodes = ['DEV', 'DES', 'GTM', 'STR'];

const existing = await db.collection('users').countDocuments({ email: /^seed\./ });
const START = existing;
const COUNT = 60;

const userDocs = [];
for (let i = 0; i < COUNT; i += 1) {
  const idx = START + i;
  const first = firstNames[idx % firstNames.length];
  const last = lastNames[(idx * 7) % lastNames.length];
  const dept = depts.find((d) => d.code === deptCodes[idx % deptCodes.length]);
  userDocs.push({
    role: 'employee',
    roleId: employeeRole?._id ?? null,
    departmentId: dept._id,
    department: dept.name,
    firstName: first,
    lastName: last,
    name: `${first} ${last}`,
    email: `seed.${idx}@grubpac.com`,
    mobile: `9${String(8000000000 + idx * 97).slice(0, 9)}`,
    whatsappOptIn: false,
    employeeCode: `EMP${String(2000 + idx).padStart(4, '0')}`,
    designation: designations[idx % designations.length],
    joiningDate: new Date(Date.UTC(2025, 0, 1 + (idx % 360))),
    dateOfBirth: null,
    endingDate: null,
    passwordHash,
    pin4Hash: null,
    pin6Hash: null,
    monthlySalary: null,
    isActive: true,
    tokenVersion: 0,
    lastLoginAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

console.log(`Inserting ${userDocs.length} users...`);
const inserted = await db.collection('users').insertMany(userDocs);
const realIds = Object.values(inserted.insertedIds);

// Build attendance with the real user ids
const attDocs = [];
const today = new Date();
const todayKey = toKey(today);
const wkMap = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 0 };
const curStart = addDays(todayKey, wkMap[weekday(todayKey)] === 0 ? -6 : 1 - wkMap[weekday(todayKey)]);

for (let i = 0; i < COUNT; i += 1) {
  const userId = realIds[i];
  for (let w = 2; w >= 0; w -= 1) {
    const wkStart = addDays(curStart, -7 * w);
    for (let di = 0; di < 5; di += 1) {
      let key = addDays(wkStart, di);
      if (weekday(key) === 'Sat') key = addDays(key, 2);
      if (weekday(key) === 'Sun') key = addDays(key, 1);
      if (key > todayKey) continue;
      const dayDate = fromKey(key);
      const isWfh = (i + w + di) % 3 === 0;
      const loc = isWfh ? HOME : OFFICE;
      const checkIn = new Date(dayDate.getTime() + ((8 + (i % 2)) * 60 + rand(0, 45)) * 60000);
      const checkOut = new Date(dayDate.getTime() + ((17 + (i % 2)) * 60 + rand(0, 30)) * 60000);
      const warning = (i + w + di) % 11 === 0;
      const base = {
        userId,
        attendanceMode: isWfh ? 'wfh' : 'office',
        leaveStatus: 'approved',
        latitude: loc.lat,
        longitude: loc.lng,
        accuracyMeters: rand(8, 90),
        distanceMeters: isWfh ? 10000 + rand(0, 4000) : rand(50, 4800),
        officeLatitude: OFFICE.lat,
        officeLongitude: OFFICE.lng,
        radiusMeters: OFFICE.radius,
        status: 'allowed',
        rejectionReasons: [],
        attendanceTag: 'P',
        lateNote: null,
        warningIssued: warning,
        quarterWarningIndex: warning ? (i % 3) + 1 : null,
        autoCheckout: false,
      };
      attDocs.push({ ...base, type: 'check_in', timestamp: checkIn, createdAt: checkIn, updatedAt: checkIn });
      attDocs.push({ ...base, type: 'check_out', timestamp: checkOut, createdAt: checkOut, updatedAt: checkOut, attendanceTag: null, warningIssued: false, quarterWarningIndex: null });
    }
  }
}

console.log(`Inserting ${attDocs.length} attendance records...`);
for (let i = 0; i < attDocs.length; i += 500) {
  await db.collection('attendancerecords').insertMany(attDocs.slice(i, i + 500));
}

const totalUsers = await db.collection('users').countDocuments({ isActive: true, role: { $ne: 'admin' } });
const totalAtt = await db.collection('attendancerecords').countDocuments({});
console.log('Active non-admin users now:', totalUsers);
console.log('Total attendance records now:', totalAtt);

await c.close();
console.log('DONE');
