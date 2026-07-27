/**
 * Formats server-backed attendance policy fields for employee-facing copy.
 */
export function formatCheckInOutcome(record, { allowance = 3 } = {}) {
  if (!record || record.type !== 'check_in' || record.status !== 'allowed') {
    return null;
  }

  const tag = record.attendanceTag;
  if (record.attendanceTag === 'HD') {
    return {
      headline: 'Half day',
      detail: 'Check-in was at or after the office half-day threshold.',
    };
  }

  if (record.attendanceTag === 'LV') {
    return {
      headline: 'Leave violation (LV)',
      detail: 'Late check-in with no quarterly warnings remaining.',
    };
  }

  if (record.warningIssued && record.quarterWarningIndex) {
    return {
      headline: `Present — Warning ${record.quarterWarningIndex} of ${allowance} this quarter`,
      detail: 'Late check-in within the warning window. Full-day credit applied.',
    };
  }

  if (tag === 'P') {
    return {
      headline: 'Present',
      detail: null,
    };
  }

  return null;
}

export function formatCheckInOutcomeShort(record) {
  const code = formatHistoryShortCode(record);
  return code ?? null;
}

/** Employee history short codes: P / HD / W1 / OFC / WFH / LV */
export function formatHistoryShortCode(record) {
  if (!record || record.type !== 'check_in' || record.status !== 'allowed') {
    return null;
  }

  if (record.attendanceTag === 'HD') return 'HD';
  if (record.attendanceTag === 'LV') return 'LV';
  if (record.warningIssued && record.quarterWarningIndex) {
    return `W${record.quarterWarningIndex}`;
  }
  if (record.attendanceTag === 'P') {
    return record.attendanceMode === 'wfh' ? 'WFH' : 'P';
  }
  return record.attendanceMode === 'wfh' ? 'WFH' : 'P';
}

export function formatHistoryModeShort(record) {
  if (!record) return null;
  if (record.attendanceMode === 'wfh') return 'WFH';
  if (record.type === 'check_in' && record.status === 'allowed') return 'OFC';
  return record.attendanceMode === 'wfh' ? 'WFH' : 'OFC';
}

export function formatQuarterWarningBalance({ used = 0, allowance = 3, remaining = 0, quarter }) {
  const quarterLabel = quarter?.label ? `${quarter.label}: ` : '';
  const remainingText =
    remaining > 0
      ? `${remaining} warning${remaining === 1 ? '' : 's'} left this quarter`
      : 'No warnings remaining this quarter';
  return `${quarterLabel}${used} of ${allowance} used · ${remainingText}`;
}
