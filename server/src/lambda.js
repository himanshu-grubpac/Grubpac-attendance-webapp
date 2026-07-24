import serverlessExpress from '@codegenie/serverless-express';
import mongoose from 'mongoose';
import { app } from './index.js';
import { connectDatabase } from './config/db.js';

let serverlessHandler;

async function ensureDatabase() {
  if (mongoose.connection.readyState === 0) {
    await connectDatabase();
  }
}

export const handler = async (event, context) => {
  // Reuse the MongoDB connection across warm Lambda invocations.
  context.callbackWaitsForEmptyEventLoop = false;
  await ensureDatabase();

  if (!serverlessHandler) {
    serverlessHandler = serverlessExpress({ app });
  }

  return serverlessHandler(event, context);
};
