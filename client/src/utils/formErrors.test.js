import { describe, it, expect, vi } from 'vitest';
import { showFormError, buildDocCertificateError } from './formErrors.js';

describe('showFormError', () => {
  it('sets message and field errors, then scrolls alert into view and focuses it', () => {
    const setError = vi.fn();
    const setFieldErrors = vi.fn();
    const scrollIntoView = vi.fn();
    const focus = vi.fn();
    const alertRef = { current: { scrollIntoView, focus } };

    showFormError({
      setError,
      setFieldErrors,
      alertRef,
      message: 'Overlap!',
      fieldErrors: { startDate: 'Overlaps' },
    });

    expect(setError).toHaveBeenCalledWith('Overlap!');
    expect(setFieldErrors).toHaveBeenCalledWith({ startDate: 'Overlaps' });
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' });
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it('is safe without a mounted alert node', () => {
    const setError = vi.fn();
    expect(() =>
      showFormError({ setError, alertRef: { current: null }, message: 'Boom' }),
    ).not.toThrow();
    expect(setError).toHaveBeenCalledWith('Boom');
  });

  it('skips empty field-error maps', () => {
    const setError = vi.fn();
    const setFieldErrors = vi.fn();
    showFormError({ setError, setFieldErrors, message: 'Boom', fieldErrors: {} });
    expect(setFieldErrors).not.toHaveBeenCalled();
    expect(setError).toHaveBeenCalledWith('Boom');
  });
});

describe('buildDocCertificateError', () => {
  const base = {
    isWfhMode: false,
    leaveTypeCode: 'SL',
    threshold: 2,
    requestedDays: 4,
    previewIsCurrent: true,
    halfDay: '',
    hasDocument: false,
  };

  it('blocks long sick leave without a certificate', () => {
    const message = buildDocCertificateError(base);
    expect(message).toMatch(/Medical certificate/i);
    expect(message).toMatch(/SL/);
  });

  it('passes when documented, short, half-day, WFH, or preview is stale', () => {
    expect(buildDocCertificateError({ ...base, hasDocument: true })).toBe('');
    expect(buildDocCertificateError({ ...base, requestedDays: 2 })).toBe('');
    expect(buildDocCertificateError({ ...base, halfDay: 'am' })).toBe('');
    expect(buildDocCertificateError({ ...base, isWfhMode: true })).toBe('');
    expect(buildDocCertificateError({ ...base, previewIsCurrent: false })).toBe('');
    expect(buildDocCertificateError({ ...base, threshold: null })).toBe('');
  });
});
