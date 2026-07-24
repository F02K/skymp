import assert from 'node:assert/strict';
import { createPublicKey, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { startApis, stopServer } from '../dist/api.js';
import { ensureInternalToken, loadConfig, validateConfig, validateRuntimePaths } from '../dist/config.js';
import { createLogger, sanitize } from '../dist/logger.js';
import { RuntimeState } from '../dist/runtime-state.js';
import { Supervisor } from '../dist/supervisor.js';
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

test('runtime paths support validated relative and intentional absolute plugin paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skymp-paths-'));
  const item = config(root);
  item.server.dataDirectory = join(root, 'data');
  item.server.gamemode = join(root, 'gamemode.js');
  item.server.loadOrder = ['Skyrim.esm', join(root, 'absolute.esl')];
  await (await import('node:fs/promises')).mkdir(item.server.dataDirectory);
  await Promise.all([
    writeFile(item.server.gamemode, ''),
    writeFile(join(item.server.dataDirectory, 'Skyrim.esm'), ''),
    writeFile(join(root, 'absolute.esl'), ''),
  ]);
  assert.doesNotThrow(() => validateRuntimePaths(item));
  item.server.loadOrder.push(join(root, 'missing.esp'));
  assert.throws(() => validateRuntimePaths(item), /server\.loadOrder entry.*does not exist/u);
  await rm(root, { recursive: true, force: true });
});

test('legacy default gamemode and relative runtime paths resolve beside the backend config', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skymp-config-paths-'));
  const item = config(root);
  item.internalApi.port = 3001;
  item.server.gamemode = 'default';
  item.server.dataDirectory = './data';
  const configPath = join(root, 'backend.config.json');
  await writeFile(configPath, JSON.stringify(item));
  const loaded = loadConfig(configPath);
  assert.equal(loaded.server.gamemode, join(root, 'gamemode.js'));
  assert.equal(loaded.server.dataDirectory, join(root, 'data'));
  await rm(root, { recursive: true, force: true });
});

test('logger persists redacted JSON lines for parent and child contexts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skymp-log-'));
  const logPath = join(root, 'managed-server.jsonl');
  const logger = createLogger({ component: 'core' }, { filePath: logPath });
  logger.info('started', { token: 'do-not-write' });
  logger.child({ component: 'supervisor' }).error('child failed', { code: 1 });
  const lines = (await readFile(logPath, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].token, '[REDACTED]');
  assert.equal(lines[1].component, 'supervisor');
  assert.equal(lines[1].message, 'child failed');
  await rm(root, { recursive: true, force: true });
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

test('supervisor keeps a child online after its authenticated readiness heartbeat', async () => {
  const value = await fixture();
  const childPath = join(value.root, 'heartbeat-child.mjs');
  await writeFile(childPath, `
const response = await fetch(process.env.TEST_BACKEND_URL + '/api/internal/servers/test/heartbeat', {
  method: 'POST',
  headers: {
    authorization: 'Bearer ' + process.env.TEST_BACKEND_TOKEN,
    'content-type': 'application/json',
  },
  body: JSON.stringify({ online: 0, maxPlayers: 10 }),
});
if (!response.ok) process.exit(2);
setInterval(() => {}, 1000);
`);
  const supervisorConfig = {
    command: process.execPath,
    args: [childPath],
    cwd: value.root,
    readyTimeoutMs: 300,
    shutdownTimeoutMs: 1000,
    restart: {
      enabled: true,
      initialDelayMs: 10,
      maxDelayMs: 20,
      maxAttempts: 2,
      windowMs: 5000,
    },
  };
  const states = [];
  value.state.on('status', (status) => states.push(status.state));
  const supervisor = new Supervisor(
    supervisorConfig,
    value.state,
    createLogger({ test: true, component: 'supervisor' }),
  );
  const port = value.apis.internalServer.address().port;
  await supervisor.start({
    TEST_BACKEND_URL: `http://127.0.0.1:${port}`,
    TEST_BACKEND_TOKEN: 'local-only',
  });
  await waitFor(() => value.state.get().state === 'online');
  const childPid = value.state.get().childPid;
  await new Promise((resolve) => setTimeout(resolve, supervisorConfig.readyTimeoutMs * 2));
  assert.equal(value.state.get().state, 'online');
  assert.equal(value.state.get().childPid, childPid);
  assert.equal(states.includes('restart-backoff'), false);
  await supervisor.stop();
  await stopServer(value.apis.internalServer);
  await value.storage.close();
  await rm(value.root, { recursive: true, force: true });
});

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for test condition');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
