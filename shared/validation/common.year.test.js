import test from 'node:test';
import assert from 'node:assert/strict';
import { pastOrCurrentYearSchema } from './common.js';

function currentIstYear() {
  return Number(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .format(new Date())
      .slice(0, 4),
  );
}

test('pastOrCurrentYearSchema accepts the current IST year', () => {
  const currentYear = currentIstYear();
  assert.equal(pastOrCurrentYearSchema.parse(String(currentYear)), currentYear);
});

test('pastOrCurrentYearSchema rejects a future year', () => {
  const futureYear = currentIstYear() + 1;
  assert.throws(
    () => pastOrCurrentYearSchema.parse(String(futureYear)),
    /future/i,
  );
});
