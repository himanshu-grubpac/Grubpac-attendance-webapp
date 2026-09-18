import { useEffect, useState } from 'react';
import { adminApi } from '../services/api.js';

// Session-wide cache: every year dropdown shares one stats read.
let cachedOldestYear;

export function __resetOldestJoiningYearCache() {
  cachedOldestYear = undefined;
}

/**
 * Oldest employee joining year for dynamic year dropdowns. Returns null
 * while loading or when unavailable (callers fall back to static ranges).
 */
export function useOldestJoiningYear() {
  const [oldestYear, setOldestYear] = useState(cachedOldestYear ?? null);

  useEffect(() => {
    if (cachedOldestYear !== undefined) {
      setOldestYear(cachedOldestYear);
      return undefined;
    }
    let cancelled = false;
    // Optional chaining: the year lists are progressive enhancement — a
    // missing endpoint must degrade to static ranges, never crash a page.
    Promise.resolve()
      .then(() => adminApi?.getEmployeeStats?.())
      .then((data) => {
        const value = data?.stats?.oldestJoiningYear ?? null;
        cachedOldestYear = Number.isInteger(value) ? value : null;
        if (!cancelled) setOldestYear(cachedOldestYear);
      })
      .catch(() => {
        cachedOldestYear = null;
        if (!cancelled) setOldestYear(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return oldestYear;
}
