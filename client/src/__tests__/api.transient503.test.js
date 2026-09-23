import { describe, expect, it } from 'vitest';
import { getErrorMessage } from '../services/api.js';

describe('getErrorMessage — transient 503', () => {
  it('uses API message when present', () => {
    expect(
      getErrorMessage({
        response: {
          status: 503,
          data: { message: 'Database temporarily unavailable.', code: 'DB_UNAVAILABLE' },
        },
      }),
    ).toBe('Database temporarily unavailable.');
  });

  it('falls back to user-friendly copy when body is empty', () => {
    expect(
      getErrorMessage({
        response: { status: 503, data: {} },
        message: 'Request failed with status code 503',
      }),
    ).toBe('The server is temporarily unavailable. Please wait a moment and try again.');
  });
});
