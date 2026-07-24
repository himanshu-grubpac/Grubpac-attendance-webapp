import dns from 'node:dns';
import mongoose from 'mongoose';
import { env } from './env.js';

let memoryServer;

export async function connectDatabase() {
  mongoose.set('strictQuery', true);

  let uri = env.mongoUri;
  const options = {
    serverSelectionTimeoutMS: 15000,
  };

  if (process.env.USE_MEMORY_DB === 'true') {
    const { MongoMemoryReplSet } = await import('mongodb-memory-server');
    if (!memoryServer) {
      memoryServer = await MongoMemoryReplSet.create({
        replSet: { count: 1 },
      });
      await memoryServer.waitUntilRunning();
    }
    uri = memoryServer.getUri();
    console.log('Using in-memory MongoDB replica set for development/verification.');
  } else if (uri.startsWith('mongodb+srv://')) {
    // Some networks block SRV lookups from Node; public DNS resolves Atlas SRV reliably.
    dns.setServers(['8.8.8.8', '1.1.1.1']);
  }

  await mongoose.connect(uri, options);
}

export async function disconnectDatabase() {
  await mongoose.disconnect();
  if (memoryServer) {
    await memoryServer.stop();
    memoryServer = null;
  }
}
