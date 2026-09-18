import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatInr,
  formatInrCurrency,
  formatInrInteger,
  formatInrNumber,
} from './formatInr.js';

test('formatInrNumber uses Indian grouping with two decimals', () => {
  assert.equal(formatInrNumber(100000), '1,00,000.00');
  assert.equal(formatInrNumber(1234.5), '1,234.50');
  assert.equal(formatInrNumber(null), '');
  assert.equal(formatInrNumber(''), '');
});

test('formatInrCurrency prefixes rupee symbol', () => {
  assert.equal(formatInrCurrency(100000), '₹1,00,000.00');
  assert.equal(formatInrCurrency(null), '—');
});

test('formatInrInteger omits decimals', () => {
  assert.equal(formatInrInteger(100000), '1,00,000');
  assert.equal(formatInrInteger(null), '');
});

test('formatInr display helper', () => {
  assert.equal(formatInr(100000), '1,00,000');
  assert.equal(formatInr(null), '—');
});
