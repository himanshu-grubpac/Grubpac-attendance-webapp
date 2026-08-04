import dns from 'node:dns';
import mongoose from 'mongoose';
import { env } from './env.js';

let memoryServer;
let connectPromise = null;
let lastVerifiedAt = 0;
let connectionListenersRegistered = false;

const RETRY_DELAYS_MS = [300, 800, 2000];

export const CONNECTION_VERIFY_INTERVAL_MS = Number(
  process.env.MONGO_VERIFY_INTERVAL_MS ?? 30_000,
);

export const MONGO_POOL_OPTIONS = {
  maxPoolSize: 1,
  minPoolSize: 0,
  maxIdleTimeMS: 60000,
  connectTimeoutMS: 5000,
  socketTimeoutMS: 45000,
  serverSelectionTimeoutMS: 5000,
};

export function shouldVerifyConnection(now = Date.now()) {
  return now - lastVerifiedAt >= CONNECTION_VERIFY_INTERVAL_MS;
}

export function appendSrvMaxHosts(uri) {
  if (!uri.startsWith('mongodb+srv://')) {
    return uri;
  }
  // Atlas replica sets publish replicaSet via SRV TXT records; srvMaxHosts is incompatible.
  const maxHosts = process.env.MONGO_SRV_MAX_HOSTS;
  if (!maxHosts) {
    return uri;
  }
  if (/[?&]srvMaxHosts=/i.test(uri)) {
    return uri;
  }
  if (/[?&]replicaSet=/i.test(uri)) {
    return uri;
  }
  const separator = uri.includes('?') ? '&' : '?';
  return `${uri}${separator}srvMaxHosts=${maxHosts}`;
}

export function isRetryableMongoError(error) {
  return error?.name === 'MongoNetworkError' || error?.name === 'MongooseServerSelectionError';
}

export function buildMongoConnectOptions() {
  return { ...MONGO_POOL_OPTIONS };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function registerConnectionListeners() {
  if (connectionListenersRegistered) {
    return;
  }
  connectionListenersRegistered = true;

  mongoose.connection.on('disconnected', () => {
    lastVerifiedAt = 0;
    connectPromise = null;
  });

  mongoose.connection.on('error', () => {
    lastVerifiedAt = 0;
    connectPromise = null;
  });
}

async function resolveMongoUri() {
  let uri = env.mongoUri;

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
    uri = appendSrvMaxHosts(uri);
  }

  return uri;
}

async function connectWithRetry(uri, options) {
  let lastError;

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      await mongoose.connect(uri, options);
      lastVerifiedAt = Date.now();
      console.log(JSON.stringify({
        msg: 'MongoDB connected',
        readyState: mongoose.connection.readyState,
        attempt: attempt + 1,
      }));
      return;
    } catch (error) {
      lastError = error;

      if (!isRetryableMongoError(error) || attempt >= RETRY_DELAYS_MS.length) {
        console.error(JSON.stringify({
          msg: 'MongoDB connect failed',
          error: error.name,
          attempt: attempt + 1,
        }));
        throw error;
      }

      const delayMs = RETRY_DELAYS_MS[attempt];
      console.warn(JSON.stringify({
        msg: 'MongoDB connect retry scheduled',
        attempt: attempt + 1,
        delayMs,
        error: error.name,
      }));

      try {
        await mongoose.disconnect();
      } catch {
        // Ignore cleanup errors before retry.
      }

      await sleep(delayMs);
    }
  }

  throw lastError;
}

async function ensureLiveConnection() {
  if (mongoose.connection.readyState !== 1) {
    return false;
  }

  if (!shouldVerifyConnection()) {
    return true;
  }

  try {
    await mongoose.connection.db.admin().command({ ping: 1 });
    lastVerifiedAt = Date.now();
    return true;
  } catch (error) {
    console.warn(JSON.stringify({
      msg: 'MongoDB ping failed; reconnecting',
      error: error?.name ?? 'Error',
    }));
    lastVerifiedAt = 0;
    try {
      await mongoose.disconnect();
    } catch {
      // Ignore stale connection cleanup errors.
    }
    return false;
  }
}

async function performConnect() {
  mongoose.set('strictQuery', true);
  mongoose.set('bufferCommands', false);
  registerConnectionListeners();
  const uri = await resolveMongoUri();
  const options = buildMongoConnectOptions();
  await connectWithRetry(uri, options);
}

export async function ensureMongoConnection() {
  registerConnectionListeners();

  if (await ensureLiveConnection()) {
    return;
  }

  if (connectPromise) {
    return connectPromise;
  }

  if (mongoose.connection.readyState !== 0) {
    try {
      await mongoose.disconnect();
    } catch {
      // Ignore stale connection cleanup errors.
    }
  }

  connectPromise = performConnect().finally(() => {
    connectPromise = null;
  });

  return connectPromise;
}

export async function connectDatabase() {
  return ensureMongoConnection();
}

export async function disconnectDatabase() {
  connectPromise = null;
  lastVerifiedAt = 0;
  await mongoose.disconnect();
  if (memoryServer) {
    await memoryServer.stop();
    memoryServer = null;
  }
}
