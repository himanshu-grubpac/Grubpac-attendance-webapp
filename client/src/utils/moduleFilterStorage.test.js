import { describe, it, expect, beforeEach } from 'vitest';
import {
  ADMIN_USERS_FILTER_STORAGE_KEY,
  clearModuleFilterStorage,
} from './moduleFilterStorage.js';

describe('moduleFilterStorage', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it('clears known module filter keys', () => {
    sessionStorage.setItem(
      ADMIN_USERS_FILTER_STORAGE_KEY,
      JSON.stringify({ search: 'alice' }),
    );
    clearModuleFilterStorage();
    expect(sessionStorage.getItem(ADMIN_USERS_FILTER_STORAGE_KEY)).toBeNull();
  });
});
