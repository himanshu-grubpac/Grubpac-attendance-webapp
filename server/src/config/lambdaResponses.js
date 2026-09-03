export const DB_UNAVAILABLE_RESPONSE = {
  statusCode: 503,
  headers: {
    'Content-Type': 'application/json',
    'Retry-After': '2',
  },
  body: JSON.stringify({
    message: 'Database temporarily unavailable.',
    code: 'DB_UNAVAILABLE',
  }),
};
