/** Canonical format: 2–5 uppercase letters + 3–6 digits (EMP001, TL001, EMP2042). */
export const EMPLOYEE_CODE_REGEX = /^[A-Z]{2,5}\d{3,6}$/;

export const EMPLOYEE_CODE_FORMAT_HINT =
  '2–5 letters followed by 3–6 digits (e.g. EMP001, TL001). Leave blank to auto-generate.';
