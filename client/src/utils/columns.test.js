import { describe, expect, it } from 'vitest';
import { filterAllowedColumns } from './columns.js';

const ALL = [
  { key: 'name', label: 'Name' },
  { key: 'email', label: 'Email' },
  { key: 'salary', label: 'Salary' },
];

describe('filterAllowedColumns', () => {
  it('drops columns the caller may not access (e.g. salary)', () => {
    expect(filterAllowedColumns(ALL, ['name', 'email']).map((c) => c.key)).toEqual([
      'name',
      'email',
    ]);
  });

  it('keeps everything when the allow-list is not loaded yet', () => {
    expect(filterAllowedColumns(ALL, null)).toBe(ALL);
    expect(filterAllowedColumns(ALL, undefined)).toBe(ALL);
  });

  it('returns an empty list when nothing is allowed', () => {
    expect(filterAllowedColumns(ALL, [])).toEqual([]);
  });
});
