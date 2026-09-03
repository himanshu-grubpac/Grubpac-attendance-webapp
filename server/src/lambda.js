import serverlessExpress from '@codegenie/serverless-express';
import { app } from './index.js';
import { ensureMongoConnection } from './config/db.js';
import { lambdaBinarySettings } from './config/lambdaBinarySettings.js';
import { DB_UNAVAILABLE_RESPONSE } from './config/lambdaResponses.js';

let serverlessHandler;

// Warm connect on cold init — does not block first request if it fails.
ensureMongoConnection().catch(() => {});

export const handler = async (event, context) => {
  // Warm containers reuse the same Node process and MongoDB connection.
  // Each concurrent cold start spins up a separate container (~1 Atlas connection).
  context.callbackWaitsForEmptyEventLoop = false;

  try {
    await ensureMongoConnection();
  } catch (error) {
    console.error(JSON.stringify({
      msg: 'MongoDB connect failed at Lambda entry',
      error: error?.name ?? 'Error',
      message: error?.message,
    }));
    return DB_UNAVAILABLE_RESPONSE;
  }

  if (!serverlessHandler) {
    serverlessHandler = serverlessExpress({
      app,
      binarySettings: lambdaBinarySettings,
    });
  }

  return serverlessHandler(event, context);
};
