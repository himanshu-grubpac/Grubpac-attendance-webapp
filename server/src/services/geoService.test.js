import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateGeoAttendance } from './geoService.js';

const office = {
  latitude: 28.6139,
  longitude: 77.209,
  radiusMeters: 100,
  maxAccuracyMeters: 50,
};

const distantFreshLocation = {
  latitude: 28.7041,
  longitude: 77.1025,
  accuracyMeters: 10,
  clientTimestamp: new Date().toISOString(),
  office,
};

test('Office attendance rejects a fresh location outside the office radius', () => {
  const result = evaluateGeoAttendance({ ...distantFreshLocation, enforceOfficeRadius: true });
  assert.equal(result.isAllowed, false);
  assert.match(result.rejectionReasons.join(' '), /outside the office radius/i);
});

test('WFH attendance accepts a fresh accurate location outside the office radius', () => {
  const result = evaluateGeoAttendance({ ...distantFreshLocation, enforceOfficeRadius: false });
  assert.equal(result.isAllowed, true);
  assert.equal(result.rejectionReasons.length, 0);
});

test('Office attendance far from office reports distance, not misleading accuracy', () => {
  const result = evaluateGeoAttendance({
    ...distantFreshLocation,
    accuracyMeters: 75,
    enforceOfficeRadius: true,
  });
  assert.equal(result.isAllowed, false);
  const combined = result.rejectionReasons.join(' ');
  assert.match(combined, /outside the office radius/i);
  assert.doesNotMatch(combined, /accuracy must be/i);
});

test('Office attendance rejects poor accuracy only when within radius uncertainty', () => {
  const nearOffice = {
    latitude: office.latitude + 0.0001,
    longitude: office.longitude + 0.0001,
    accuracyMeters: 75,
    clientTimestamp: new Date().toISOString(),
    office,
    enforceOfficeRadius: true,
  };
  const result = evaluateGeoAttendance(nearOffice);
  assert.equal(result.isAllowed, false);
  assert.match(result.rejectionReasons.join(' '), /accuracy must be/i);
});

test('WFH attendance skips office accuracy limits but still requires a reading', () => {
  const inaccurate = evaluateGeoAttendance({
    ...distantFreshLocation,
    accuracyMeters: 75,
    enforceOfficeRadius: false,
  });
  assert.equal(inaccurate.isAllowed, true);
  assert.equal(inaccurate.rejectionReasons.length, 0);

  const missingAccuracy = evaluateGeoAttendance({
    ...distantFreshLocation,
    accuracyMeters: Number.NaN,
    enforceOfficeRadius: false,
  });
  assert.equal(missingAccuracy.isAllowed, false);
  assert.match(missingAccuracy.rejectionReasons.join(' '), /accuracy/i);
});
