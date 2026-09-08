import { afterEach, describe, expect, it, vi } from 'vitest';
import api, { adminApi, leaveApi } from '../services/api.js';

// Regression test: Excel uploads must NOT inherit the instance
// `application/json` Content-Type (axios would serialize the FormData to
// '{"file":{}}' and multer would see no file). The calls set an explicit
// boundary-free `multipart/form-data` type; real browsers append the
// boundary parameter (verified with a Chromium wire test), so multer parses it.
function captureAdapter() {
  const seen = [];
  const adapter = vi.fn((config) =>
    Promise.resolve({
      data: {},
      status: 200,
      statusText: 'OK',
      headers: {},
      config,
    }),
  );
  const previous = api.defaults.adapter;
  api.defaults.adapter = async (config) => {
    seen.push(config);
    return adapter(config);
  };
  return {
    seen,
    restore: () => {
      api.defaults.adapter = previous;
    },
  };
}

describe('Excel upload content type', () => {
  let capture;

  afterEach(() => {
    capture?.restore();
    capture = null;
  });

  it('bulkUpload sends FormData with an explicit multipart content type', async () => {
    capture = captureAdapter();
    const file = new File(['PK'], 'employees.xlsx', {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    await adminApi.bulkUpload(file);

    expect(capture.seen).toHaveLength(1);
    const [config] = capture.seen;
    expect(config.data instanceof FormData).toBe(true);
    expect(config.headers.getContentType()).toMatch(/^multipart\/form-data/);
  });

  it('uploadCarryBulk sends FormData with an explicit multipart content type', async () => {
    capture = captureAdapter();
    const file = new File(['PK'], 'carry.xlsx', {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    await leaveApi.uploadCarryBulk(file);

    expect(capture.seen).toHaveLength(1);
    const [config] = capture.seen;
    expect(config.data instanceof FormData).toBe(true);
    expect(config.headers.getContentType()).toMatch(/^multipart\/form-data/);
  });
});
