import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import {
  useOldestJoiningYear,
  __resetOldestJoiningYearCache,
} from '../hooks/useOldestJoiningYear.js';
import { adminApi } from '../services/api.js';

vi.mock('../services/api.js', () => ({
  adminApi: {
    getEmployeeStats: vi.fn(() => Promise.resolve({ stats: { oldestJoiningYear: 2021 } })),
  },
}));

function Probe() {
  const year = useOldestJoiningYear();
  return <p>{year === null ? 'none' : String(year)}</p>;
}

describe('useOldestJoiningYear', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetOldestJoiningYearCache();
  });

  it('returns the oldest joining year from stats', async () => {
    render(<Probe />);
    await waitFor(() => expect(screen.getByText('2021')).toBeInTheDocument());
    expect(adminApi.getEmployeeStats).toHaveBeenCalledTimes(1);
  });

  it('shares one cached read across mounts', async () => {
    render(<Probe />);
    await waitFor(() => expect(screen.getAllByText('2021')).toHaveLength(1));
    render(<Probe />);
    await waitFor(() => expect(screen.getAllByText('2021')).toHaveLength(2));
    expect(adminApi.getEmployeeStats).toHaveBeenCalledTimes(1);
  });
});
