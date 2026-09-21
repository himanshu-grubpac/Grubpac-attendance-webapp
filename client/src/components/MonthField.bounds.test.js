import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  buildSalaryMonthOptions,
  buildSalaryYearOptions,
  clampMonthValue,
  resolveEmployeePeriodBounds,
} from './MonthField.jsx';

describe('MonthField employee period bounds', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps global year range when bounds are omitted', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-18T06:30:00.000Z'));

    const years = buildSalaryYearOptions();
    expect(years.map((option) => option.value)).toEqual([
      '2026',
      '2025',
      '2024',
    ]);
  });

  it('limits join-year months to join month through current IST month', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-18T06:30:00.000Z'));

    const bounds = { joiningDate: '2026-09-18', endingDate: null };
    const months = buildSalaryMonthOptions('2026', bounds);

    expect(months.map((option) => option.value)).toEqual(['09']);
    expect(buildSalaryYearOptions(bounds).map((option) => option.value)).toEqual(['2026']);
  });

  it('clamps selected month to join month minimum', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-18T06:30:00.000Z'));

    const bounds = { joiningDate: '2026-09-18', endingDate: null };
    expect(clampMonthValue('2026-03', bounds)).toBe('2026-09');
  });

  it('respects endingDate as the max selectable month', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-18T06:30:00.000Z'));

    const bounds = {
      joiningDate: '2026-01-01',
      endingDate: '2026-06-30',
    };
    const { maxYear, maxMonth } = resolveEmployeePeriodBounds(bounds);

    expect(maxYear).toBe(2026);
    expect(maxMonth).toBe(6);
    expect(buildSalaryMonthOptions('2026', bounds).map((option) => option.value)).toEqual([
      '01',
      '02',
      '03',
      '04',
      '05',
      '06',
    ]);
  });
});
