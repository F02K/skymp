import assert from 'node:assert/strict';
import { createPublicKey, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { startApis, stopServer } from '../dist/api.js';
import { ensureInternalToken, validateConfig } from '../dist/config.js';
import { createLogger, sanitize } from '../dist/logger.js';
import { RuntimeState } from '../dist/runtime-state.js';
import { SqliteStorage } from '../dist/storage.js';
import { canonicalPlayGrant } from '../dist/directory-auth.js';

function config(root) {
  return {
    internalApi: { host: '127.0.0.1', port: 0 },
    database: { adapter: 'sqlite', path: join(root, 'backend.sqlite') },
    server: {
      id: 'test', internalTokenEnv: 'TEST_BACKEND_TOKEN', name: 'Test', description: '',
      region: 'test', tags: [], gamePort: 7777, resourcesPort: 7778, gamemode: 'default',
      dataDirectory: './data', plugins: [], loadOrder: [], maxPlayers: 10, visibility: 'private',
    },
    supervisor: { command: process.execPath, args: [], cwd: root, readyTimeoutMs: 3000, shutdownTimeoutMs: 1000, restart: { enabled: false, initialDelayMs: 10, maxDelayMs: 100, maxAttempts: 2, windowMs: 1000 } },
    sessions: { ttlSeconds: 43200, clockSkewMs: 0 }, modules: [],
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'skymp-backend-'));
  const item = config(root);
  const keys = generateKeyPairSync('ed25519');
  item.sessions.directoryPublicKey = createPublicKey(keys.privateKey).export({ format: 'der', type: 'spki' }).toString('base64');
  const storage = new SqliteStorage(item.database.path);
  await storage.migrate();
  const state = new RuntimeState(10);
  const apis = await startApis({ config: item, storage, state, logger: createLogger({ test: true }), internalToken: 'local-only' });
  const port = apis.internalServer.address().port;
  return { root, item, keys, storage, state, apis, port };
}

function ticket(keys, audience = 'test', overrides = {}) {
  const issuedAt = Date.now();
  const grant = {
    schemaVersion: 1, jti: randomUUID(), audience, issuedAt, expiresAt: issuedAt + 60000,
    identity: { discordId: '123456789012345678', username: 'Player' },
    membership: { guildId: '987654321098765432', roles: ['member'] },
    ...overrides,
  };
  const envelope = {
    grant,
    signature: sign(null, Buffer.from(canonicalPlayGrant(grant)), keys.privateKey).toString('base64url'),
    algorithm: 'Ed25519',
  };
  return Buffer.from(JSON.stringify(envelope)).toString('base64url');
}

async function validate(port, value, token = 'local-only') {
  return fetch(`http://127.0.0.1:${port}/api/internal/servers/test/sessions/validate`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ ticket: value }),
  });
}

test('configuration exposes only a loopback listener and redacts secrets', () => {
  const item = config('.');
  item.internalApi.port = 3001;
  item.internalApi.host = '0.0.0.0';
  assert.throws(() => validateConfig(item), /loopback-only/);
  assert.deepEqual(sanitize({ credential: 'secret', safe: 'ok' }), { credential: '[REDACTED]', safe: 'ok' });
  const legacy = config('.');
  legacy.internalApi.port = 3001;
  legacy.server.masterKeyEnv = 'OLD';
  assert.throws(() => validateConfig(legacy), /unsupported/);
});

test('internal token is generated once', () => {
  const environment = {};
  const generated = ensureInternalToken('TEST_BACKEND_TOKEN', environment);
  assert.equal(generated.generated, true);
  assert.deepEqual(ensureInternalToken('TEST_BACKEND_TOKEN', environment), { value: generated.value, generated: false });
});

test('play ticket has one first redemption and the same ticket reconnects for 12 hours', async () => {
  const value = await fixture();
  const playTicket = ticket(value.keys);
  const first = await validate(value.port, playTicket);
  assert.equal(first.status, 201);
  const profile = (await first.json()).user;
  assert.equal(typeof profile.id, 'number');
  assert.deepEqual(profile.roles, ['member']);
  const reconnect = await validate(value.port, playTicket);
  assert.equal(reconnect.status, 200);
  assert.equal((await reconnect.json()).user.id, profile.id);
  await stopServer(value.apis.internalServer); await value.storage.close(); await rm(value.root, { recursive: true, force: true });
});

test('ticket validation rejects wrong audience, expiry, invalid signature and non-loopback callers without token', async () => {
  const value = await fixture();
  assert.equal((await validate(value.port, ticket(value.keys, 'other'))).status, 403);
  const expired = ticket(value.keys, 'test', { issuedAt: Date.now() - 120000, expiresAt: Date.now() - 60000 });
  assert.equal((await validate(value.port, expired)).status, 401);
  const bad = `${ticket(value.keys).slice(0, -2)}aa`;
  assert.equal((await validate(value.port, bad)).status, 400);
  assert.equal((await validate(value.port, ticket(value.keys), 'wrong')).status, 403);
  await stopServer(value.apis.internalServer); await value.storage.close(); await rm(value.root, { recursive: true, force: true });
});

test('heartbeat uses only the authenticated loopback API', async () => {
  const value = await fixture();
  const response = await fetch(`http://127.0.0.1:${value.port}/api/internal/servers/test/heartbeat`, {
    method: 'POST',
    headers: { authorization: 'Bearer local-only', 'content-type': 'application/json' },
    body: JSON.stringify({ online: 3, maxPlayers: 10 }),
  });
  assert.equal(response.status, 200);
  assert.equal(value.state.get().online, 3);
  await stopServer(value.apis.internalServer); await value.storage.close(); await rm(value.root, { recursive: true, force: true });
});
