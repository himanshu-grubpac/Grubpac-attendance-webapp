import { describe, it, expect } from 'vitest';
import { buildDynamicYearOptions } from './yearOptions.js';

describe('buildDynamicYearOptions', () => {
  it('spans oldest joining year through current year with no future', () => {
    expect(buildDynamicYearOptions(2021, 2026)).toEqual([
      { value: '2026', label: '2026' },
      { value: '2025', label: '2025' },
      { value: '2024', label: '2024' },
      { value: '2023', label: '2023' },
      { value: '2022', label: '2022' },
      { value: '2021', label: '2021' },
    ]);
  });

  it('clamps a future oldest year down to current', () => {
    expect(buildDynamicYearOptions(2030, 2026)).toEqual([
      { value: '2026', label: '2026' },
    ]);
  });

  it('falls back to the legacy window when oldest is unknown', () => {
    const options = buildDynamicYearOptions(null, 2026);
    expect(options.map((option) => option.value)).toEqual(['2026', '2025', '2024', '2023', '2022']);
  });

  it('supports a leading option and next-year planning', () => {
    const options = buildDynamicYearOptions(2025, 2026, {
      leading: { value: '', label: 'All years' },
      includeNextYear: true,
    });
    expect(options.map((option) => option.value)).toEqual(['', '2027', '2026', '2025']);
  });
});
