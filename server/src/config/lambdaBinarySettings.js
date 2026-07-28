/**
 * MIME types that must be base64-encoded when returned through API Gateway.
 * @codegenie/serverless-express defaults to image/* only; Excel buffers corrupt
 * in production if spreadsheet types are omitted (isBase64Encoded stays false).
 */
export const LAMBDA_BINARY_CONTENT_TYPES = [
  'image/*',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'application/octet-stream',
];

export const lambdaBinarySettings = {
  contentTypes: LAMBDA_BINARY_CONTENT_TYPES,
};
