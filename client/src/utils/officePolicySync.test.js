// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import {
  OFFICE_POLICY_EVENT,
  OFFICE_POLICY_STORAGE_KEY,
  broadcastOfficePolicyUpdated,
} from './officePolicySync.js';

describe('broadcastOfficePolicyUpdated', () => {
  it('dispatches the policy event with the settings as detail', () => {
    const listener = vi.fn();
    window.addEventListener(OFFICE_POLICY_EVENT, listener);
    try {
      const settings = { officeStartTime: '09:00', autoCheckout: { enabled: true } };
      broadcastOfficePolicyUpdated(settings);
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener.mock.calls[0][0].detail).toBe(settings);
    } finally {
      window.removeEventListener(OFFICE_POLICY_EVENT, listener);
    }
  });

  it('mirrors the settings JSON to localStorage for cross-tab listeners', () => {
    const settings = { officeStartTime: '09:00' };
    broadcastOfficePolicyUpdated(settings);
    expect(JSON.parse(localStorage.getItem(OFFICE_POLICY_STORAGE_KEY))).toEqual(settings);
  });

  it('still dispatches when localStorage is unavailable', () => {
    const listener = vi.fn();
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = vi.fn(() => {
      throw new Error('denied');
    });
    window.addEventListener(OFFICE_POLICY_EVENT, listener);
    try {
      expect(() => broadcastOfficePolicyUpdated({ officeStartTime: '09:00' })).not.toThrow();
      expect(listener).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener(OFFICE_POLICY_EVENT, listener);
      Storage.prototype.setItem = original;
    }
  });

  it('ignores nullish payloads without dispatching', () => {
    const listener = vi.fn();
    window.addEventListener(OFFICE_POLICY_EVENT, listener);
    try {
      expect(() => broadcastOfficePolicyUpdated(null)).not.toThrow();
      expect(() => broadcastOfficePolicyUpdated(undefined)).not.toThrow();
      expect(listener).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener(OFFICE_POLICY_EVENT, listener);
    }
  });
});
