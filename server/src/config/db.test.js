import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CONNECTION_VERIFY_INTERVAL_MS,
  MONGO_POOL_OPTIONS,
  appendSrvMaxHosts,
  buildMongoConnectOptions,
  isRetryableMongoError,
  shouldVerifyConnection,
} from './db.js';

test('appendSrvMaxHosts leaves SRV URI unchanged by default (Atlas replica sets)', () => {
  const uri = 'mongodb+srv://user:pass@cluster.example.net/mydb';
  assert.equal(appendSrvMaxHosts(uri), uri);
});

test('appendSrvMaxHosts adds srvMaxHosts when MONGO_SRV_MAX_HOSTS is set', () => {
  const uri = 'mongodb+srv://user:pass@cluster.example.net/mydb';
  const previous = process.env.MONGO_SRV_MAX_HOSTS;
  process.env.MONGO_SRV_MAX_HOSTS = '3';
  try {
    assert.equal(appendSrvMaxHosts(uri), `${uri}?srvMaxHosts=3`);
  } finally {
    if (previous === undefined) {
      delete process.env.MONGO_SRV_MAX_HOSTS;
    } else {
      process.env.MONGO_SRV_MAX_HOSTS = previous;
    }
  }
});

test('appendSrvMaxHosts appends srvMaxHosts when query params exist', () => {
  const uri = 'mongodb+srv://user:pass@cluster.example.net/mydb?retryWrites=true';
  const previous = process.env.MONGO_SRV_MAX_HOSTS;
  process.env.MONGO_SRV_MAX_HOSTS = '3';
  try {
    assert.equal(appendSrvMaxHosts(uri), `${uri}&srvMaxHosts=3`);
  } finally {
    if (previous === undefined) {
      delete process.env.MONGO_SRV_MAX_HOSTS;
    } else {
      process.env.MONGO_SRV_MAX_HOSTS = previous;
    }
  }
});

test('appendSrvMaxHosts leaves URI unchanged when srvMaxHosts is already set', () => {
  const uri = 'mongodb+srv://user:pass@cluster.example.net/mydb?srvMaxHosts=5';
  const previous = process.env.MONGO_SRV_MAX_HOSTS;
  process.env.MONGO_SRV_MAX_HOSTS = '3';
  try {
    assert.equal(appendSrvMaxHosts(uri), uri);
  } finally {
    if (previous === undefined) {
      delete process.env.MONGO_SRV_MAX_HOSTS;
    } else {
      process.env.MONGO_SRV_MAX_HOSTS = previous;
    }
  }
});

test('appendSrvMaxHosts leaves non-SRV URIs unchanged', () => {
  const uri = 'mongodb://localhost:27017/mydb';
  assert.equal(appendSrvMaxHosts(uri), uri);
});

test('appendSrvMaxHosts skips srvMaxHosts when replicaSet is in URI', () => {
  const uri = 'mongodb+srv://user:pass@cluster.example.net/mydb?replicaSet=atlas-abc-shard-0';
  const previous = process.env.MONGO_SRV_MAX_HOSTS;
  process.env.MONGO_SRV_MAX_HOSTS = '3';
  try {
    assert.equal(appendSrvMaxHosts(uri), uri);
  } finally {
    if (previous === undefined) {
      delete process.env.MONGO_SRV_MAX_HOSTS;
    } else {
      process.env.MONGO_SRV_MAX_HOSTS = previous;
    }
  }
});

test('buildMongoConnectOptions returns Lambda pool settings', () => {
  const options = buildMongoConnectOptions();
  assert.deepEqual(options, MONGO_POOL_OPTIONS);
  assert.equal(options.maxPoolSize, 1);
  assert.equal(options.minPoolSize, 0);
  assert.equal(options.connectTimeoutMS, 5000);
  assert.equal(options.serverSelectionTimeoutMS, 5000);
});

test('CONNECTION_VERIFY_INTERVAL_MS defaults to 30 seconds', () => {
  assert.equal(CONNECTION_VERIFY_INTERVAL_MS, 30_000);
});

test('shouldVerifyConnection returns false when last verified at epoch', () => {
  assert.equal(shouldVerifyConnection(0), false);
});

test('shouldVerifyConnection returns true after verify interval elapsed', () => {
  assert.equal(shouldVerifyConnection(CONNECTION_VERIFY_INTERVAL_MS), true);
});

test('isRetryableMongoError matches network and server selection errors', () => {
  assert.equal(isRetryableMongoError({ name: 'MongoNetworkError' }), true);
  assert.equal(isRetryableMongoError({ name: 'MongooseServerSelectionError' }), true);
  assert.equal(isRetryableMongoError({ name: 'ValidationError' }), false);
  assert.equal(isRetryableMongoError(null), false);
});
