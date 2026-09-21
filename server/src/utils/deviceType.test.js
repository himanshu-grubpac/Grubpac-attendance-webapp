process.env.NODE_ENV = 'test';

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatDeviceFullLabel,
  formatDeviceOwnerLabel,
  formatDeviceTypeLabel,
  getBrowserFromUserAgent,
  getDeviceTypeFromUserAgent,
  getOsFromUserAgent,
} from './deviceType.js';

const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const ANDROID_PHONE_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';
const ANDROID_TABLET_UA =
  'Mozilla/5.0 (Linux; Android 13; SM-T870) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const IPAD_UA =
  'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const WINDOWS_CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MAC_SAFARI_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';

test('classifies phone user-agents as mobile', () => {
  assert.equal(getDeviceTypeFromUserAgent(IPHONE_UA), 'mobile');
  assert.equal(getDeviceTypeFromUserAgent(ANDROID_PHONE_UA), 'mobile');
});

test('classifies tablet user-agents as tablet', () => {
  assert.equal(getDeviceTypeFromUserAgent(IPAD_UA), 'tablet');
  assert.equal(getDeviceTypeFromUserAgent(ANDROID_TABLET_UA), 'tablet');
});

test('classifies desktop user-agents as desktop', () => {
  assert.equal(getDeviceTypeFromUserAgent(WINDOWS_CHROME_UA), 'desktop');
  assert.equal(getDeviceTypeFromUserAgent(MAC_SAFARI_UA), 'desktop');
});

test('returns null without a user-agent', () => {
  assert.equal(getDeviceTypeFromUserAgent(null), null);
  assert.equal(getDeviceTypeFromUserAgent(undefined), null);
  assert.equal(getDeviceTypeFromUserAgent(''), null);
  assert.equal(getDeviceTypeFromUserAgent('   '), null);
});

test('formats type labels', () => {
  assert.equal(formatDeviceTypeLabel('mobile'), 'Mobile');
  assert.equal(formatDeviceTypeLabel('tablet'), 'Tablet');
  assert.equal(formatDeviceTypeLabel('desktop'), 'Desktop');
  assert.equal(formatDeviceTypeLabel(null), null);
  assert.equal(formatDeviceTypeLabel('watch'), null);
});

test('detects browser families with engine-token ordering', () => {
  assert.equal(getBrowserFromUserAgent(WINDOWS_CHROME_UA), 'Chrome');
  assert.equal(getBrowserFromUserAgent(MAC_SAFARI_UA), 'Safari');
  assert.equal(getBrowserFromUserAgent(IPHONE_UA), 'Safari');
  assert.equal(
    getBrowserFromUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0',
    ),
    'Edge',
  );
  assert.equal(
    getBrowserFromUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 OPR/106.0.0.0',
    ),
    'Opera',
  );
  assert.equal(
    getBrowserFromUserAgent(
      'Mozilla/5.0 (Linux; Android 14; SAMSUNG SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/23.0 Chrome/120.0.0.0 Mobile Safari/537.36',
    ),
    'Samsung Internet',
  );
  assert.equal(
    getBrowserFromUserAgent('Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0'),
    'Firefox',
  );
  assert.equal(getBrowserFromUserAgent(null), null);
  assert.equal(getBrowserFromUserAgent('SomeBot/1.0'), null);
});

test('detects OS families', () => {
  assert.equal(getOsFromUserAgent(WINDOWS_CHROME_UA), 'Windows');
  assert.equal(getOsFromUserAgent(MAC_SAFARI_UA), 'macOS');
  assert.equal(getOsFromUserAgent(ANDROID_PHONE_UA), 'Android');
  assert.equal(getOsFromUserAgent(IPHONE_UA), 'iOS');
  assert.equal(getOsFromUserAgent(IPAD_UA), 'iOS');
  assert.equal(
    getOsFromUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36'),
    'Linux',
  );
  assert.equal(getOsFromUserAgent(null), null);
  assert.equal(getOsFromUserAgent('SomeBot/1.0'), null);
});

test('formats full device labels with graceful degradation', () => {
  assert.equal(
    formatDeviceFullLabel('Atul', { deviceType: 'desktop', browser: 'Chrome', os: 'Windows' }),
    "Atul's Desktop — Chrome / Windows",
  );
  assert.equal(
    formatDeviceFullLabel('Neha', { deviceType: 'mobile', browser: null, os: 'Android' }),
    "Neha's Mobile — Android",
  );
  assert.equal(formatDeviceFullLabel(null, { deviceType: 'tablet' }), 'Tablet');
  assert.equal(formatDeviceFullLabel('Atul', { deviceType: null }), null);
  assert.equal(formatDeviceFullLabel('Atul', {}), null);
});

test('formats owner labels with possessives', () => {
  assert.equal(formatDeviceOwnerLabel('Grubpac Admin', 'desktop'), "Grubpac Admin's Desktop");
  assert.equal(formatDeviceOwnerLabel('Neha', 'mobile'), "Neha's Mobile");
  assert.equal(formatDeviceOwnerLabel('James', 'tablet'), "James' Tablet");
  assert.equal(formatDeviceOwnerLabel('', 'desktop'), 'Desktop');
  assert.equal(formatDeviceOwnerLabel(null, 'mobile'), 'Mobile');
  assert.equal(formatDeviceOwnerLabel('Grubpac Admin', null), null);
});
