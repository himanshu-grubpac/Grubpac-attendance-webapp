export function duplicateFieldMessage(field) {
  const messages = {
    email: 'This email is already registered.',
    mobile: 'This mobile number is already registered.',
    employeeCode: 'Employee code already in use.',
  };
  return messages[field] ?? `Duplicate value for ${field}.`;
}
