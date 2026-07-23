import assert from 'node:assert/strict';
import { createPublicKey, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { startApis, stopServer } from '../dist/api.js';
import { validateConfig } from '../dist/config.js';
import { createLogger, sanitize } from '../dist/logger.js';
import { RouterRegistry } from '../dist/module-router.js';
import { RuntimeState } from '../dist/runtime-state.js';
import { SqliteStorage } from '../dist/storage.js';
import { Supervisor } from '../dist/supervisor.js';
import { DirectoryConnector } from '../dist/modules/directory-connector.js';
import { ModuleLoader } from '../dist/module-loader.js';
import { canonicalPlayGrant } from '../dist/directory-auth.js';

function config(root) {
  return {
    publicApi: { host: '127.0.0.1', port: 0 }, internalApi: { host: '127.0.0.1', port: 0 },
    database: { adapter: 'sqlite', path: join(root, 'backend.sqlite') },
    server: { id: 'test', internalTokenEnv: 'TEST_BACKEND_TOKEN', name: 'Test', description: '', region: 'test', tags: [], publicBackendUrl: 'http://127.0.0.1', gameAddress: '127.0.0.1:7777', maxPlayers: 10, visibility: 'private' },
    supervisor: { command: process.execPath, args: [], cwd: root, readyTimeoutMs: 3000, shutdownTimeoutMs: 1000, restart: { enabled: false, initialDelayMs: 10, maxDelayMs: 100, maxAttempts: 2, windowMs: 1000 } },
    sessions: { ttlSeconds: 60 }, modules: [],
  };
}

test('configuration keeps the internal API loopback-only and secrets are redacted', () => {
  const item = config('.'); item.publicApi.port = 3000; item.internalApi.port = 3001; item.internalApi.host = '0.0.0.0';
  assert.throws(() => validateConfig(item), /loopback-only/);
  assert.deepEqual(sanitize({ credential: 'secret', nested: { internalToken: 'value' }, safe: 'ok' }), { credential: '[REDACTED]', nested: { internalToken: '[REDACTED]' }, safe: 'ok' });
  const legacyServer = config('.'); legacyServer.publicApi.port = 3000; legacyServer.internalApi.port = 3001; legacyServer.server.masterKeyEnv = 'OLD_TOKEN';
  assert.throws(() => validateConfig(legacyServer), /masterKeyEnv is unsupported/);
  const legacySessions = config('.'); legacySessions.publicApi.port = 3000; legacySessions.internalApi.port = 3001; legacySessions.sessions.issuerTokenEnv = 'OLD_ISSUER';
  assert.throws(() => validateConfig(legacySessions), /issuerTokenEnv is unsupported/);
});

test('SkyMP heartbeat and session validation use only the unversioned internal API', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skymp-backend-api-'));
  const item = config(root); const storage = new SqliteStorage(item.database.path); await storage.migrate();
  const state = new RuntimeState(10); const logger = createLogger({ test: true });
  const apis = await startApis({ config: item, storage, state, logger, internalToken: 'master', routers: new RouterRegistry() });
  const publicPort = apis.publicServer.address().port; const internalPort = apis.internalServer.address().port;
  const session = { token: 'session-token', userId: '42', username: 'Player', roles: ['member'], expiresAt: Date.now() + 60000, profileId: 42 };
  await storage.putSession(session);
  const valid = await fetch(`http://127.0.0.1:${internalPort}/api/internal/servers/test/sessions/${session.token}`, { headers: { authorization: 'Bearer master' } });
  assert.equal(valid.status, 200); assert.equal((await valid.json()).user.username, 'Player');
  const heartbeat = await fetch(`http://127.0.0.1:${internalPort}/api/internal/servers/test/heartbeat`, { method: 'POST', headers: { authorization: 'Bearer master', 'content-type': 'application/json' }, body: JSON.stringify({ online: 3, maxPlayers: 10 }) });
  assert.equal(heartbeat.status, 200); assert.equal(state.get().online, 3);
  assert.equal((await fetch(`http://127.0.0.1:${publicPort}/api/internal/servers/test/sessions/${session.token}`, { headers: { authorization: 'Bearer master' } })).status, 404);
  assert.equal((await fetch(`http://127.0.0.1:${internalPort}/api/servers/master/sessions/${session.token}`)).status, 404);
  assert.equal((await fetch(`http://127.0.0.1:${publicPort}/api/launcher/servers`)).status, 404);
  assert.equal((await fetch(`http://127.0.0.1:${publicPort}/api/v2/launcher/servers/test`)).status, 404);
  await Promise.all([stopServer(apis.publicServer), stopServer(apis.internalServer)]); await storage.close(); await rm(root, { recursive: true, force: true });
});

test('directory grants are audience-bound, one-time and map Discord users to stable numeric profiles without leaking master keys', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skymp-backend-grant-'));
  const item = config(root); const keys = generateKeyPairSync('ed25519');
  item.sessions.directoryPublicKey = createPublicKey(keys.privateKey).export({ format: 'der', type: 'spki' }).toString('base64');
  const storage = new SqliteStorage(item.database.path); await storage.migrate(); const state = new RuntimeState(10);
  const apis = await startApis({ config: item, storage, state, logger: createLogger({ test: true }), internalToken: 'never-public', routers: new RouterRegistry(), capabilities: new Set() });
  const publicPort = apis.publicServer.address().port; const internalPort = apis.internalServer.address().port;
  const makeGrant = (jti = randomUUID(), audience = 'test') => {
    const issuedAt = Date.now();
    const grant = { schemaVersion: 1, jti, audience, issuedAt, expiresAt: issuedAt + 60000, identity: { discordId: '123456789012345678', username: 'Directory Player' }, membership: { guildId: '987654321098765432', roles: ['member'] } };
    return { grant, signature: sign(null, Buffer.from(canonicalPlayGrant(grant)), keys.privateKey).toString('base64url') };
  };
  const firstBody = makeGrant();
  const first = await fetch(`http://127.0.0.1:${publicPort}/api/auth/directory/exchange`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(firstBody) });
  assert.equal(first.status, 201); const firstSession = await first.json(); assert.equal(typeof firstSession.profileId, 'number');
  const replay = await fetch(`http://127.0.0.1:${publicPort}/api/auth/directory/exchange`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(firstBody) });
  assert.equal(replay.status, 409); assert.equal((await replay.json()).error.code, 'playGrantReplayed');
  const second = await fetch(`http://127.0.0.1:${publicPort}/api/auth/directory/exchange`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(makeGrant()) });
  assert.equal(second.status, 201); assert.equal((await second.json()).profileId, firstSession.profileId);
  const wrongAudience = await fetch(`http://127.0.0.1:${publicPort}/api/auth/directory/exchange`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(makeGrant(randomUUID(), 'another-server')) });
  assert.equal(wrongAudience.status, 403);
  const detail = await (await fetch(`http://127.0.0.1:${publicPort}/api/launcher/servers/test`, { headers: { authorization: `Bearer ${firstSession.session}` } })).json();
  assert.equal(detail.masterKey, undefined); assert.equal(detail.masterKeyEnv, undefined); assert.equal(detail.capabilities.metrics, false); assert.equal(detail.capabilities.news, false); assert.equal(detail.access.allowed, true);
  const internal = await (await fetch(`http://127.0.0.1:${internalPort}/api/internal/servers/test/sessions/${firstSession.session}`, { headers: { authorization: 'Bearer never-public' } })).json();
  assert.equal(internal.user.id, firstSession.profileId); assert.deepEqual(internal.user.roles, ['member']);
  await Promise.all([stopServer(apis.publicServer), stopServer(apis.internalServer)]); await storage.close(); await rm(root, { recursive: true, force: true });
});

test('supervisor waits for a real heartbeat and shuts down its child', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skymp-supervisor-')); const item = config(root);
  const storage = new SqliteStorage(item.database.path); await storage.migrate(); const state = new RuntimeState(10);
  const apis = await startApis({ config: item, storage, state, logger: createLogger({ test: true }), internalToken: 'master', routers: new RouterRegistry() });
  const port = apis.internalServer.address().port;
  item.supervisor.args = ['-e', `setInterval(()=>fetch('http://127.0.0.1:${port}/api/internal/servers/test/heartbeat',{method:'POST',headers:{authorization:'Bearer master','content-type':'application/json'},body:JSON.stringify({online:1,maxPlayers:10})}),50)`];
  const supervisor = new Supervisor(item.supervisor, state, createLogger({ test: true })); await supervisor.start();
  await new Promise((resolve, reject) => { const timeout = setTimeout(() => reject(new Error('not ready')), 2000); state.on('status', (value) => { if (value.state === 'online') { clearTimeout(timeout); resolve(); } }); });
  assert.equal(state.get().state, 'online'); assert.ok(state.get().childPid);
  await supervisor.stop(); assert.equal(state.get().state, 'offline');
  await Promise.all([stopServer(apis.publicServer), stopServer(apis.internalServer)]); await storage.close(); await rm(root, { recursive: true, force: true });
});

test('supervisor applies backoff and stops a restart loop at the configured limit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skymp-restart-loop-')); const item = config(root);
  item.supervisor.args = ['-e', 'process.exit(7)']; item.supervisor.readyTimeoutMs = 1000;
  item.supervisor.restart = { enabled: true, initialDelayMs: 10, maxDelayMs: 20, maxAttempts: 2, windowMs: 5000 };
  const state = new RuntimeState(10); let starts = 0; let previous = 'offline'; state.on('status', (value) => { if (value.state === 'starting' && previous !== 'starting') starts += 1; previous = value.state; });
  const supervisor = new Supervisor(item.supervisor, state, createLogger({ test: true })); await supervisor.start();
  await new Promise((resolve, reject) => { const timeout = setTimeout(() => reject(new Error('restart loop did not stop')), 3000); state.on('status', (value) => { if (value.state === 'crashed' && starts === 3) { clearTimeout(timeout); resolve(); } }); });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(starts, 3); assert.equal(state.get().state, 'crashed');
  await supervisor.stop(); await rm(root, { recursive: true, force: true });
});

test('directory connector is fail-open when directory is unavailable', async () => {
  process.env.TEST_DIRECTORY_CREDENTIAL = 'credential';
  const module = new DirectoryConnector(config('.').server);
  const state = new RuntimeState(10);
  await module.start({ config: { url: 'http://127.0.0.1:1', credentialEnv: 'TEST_DIRECTORY_CREDENTIAL', heartbeatIntervalMs: 10000 }, logger: createLogger({ test: true }), events: state, getStatus: () => state.get(), getSecret: (name) => process.env[name], services: new Map(), router: { add() {} }, database: { get: async () => null, set: async () => {}, delete: async () => {}, migrate: async () => {} } });
  await module.stop(); delete process.env.TEST_DIRECTORY_CREDENTIAL;
});

test('optional module failure is isolated while a required module blocks startup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skymp-modules-'));
  const lockPath = join(process.cwd(), 'modules.lock.json');
  const state = new RuntimeState(10); const item = config(root); const storage = new SqliteStorage(item.database.path); await storage.migrate();
  item.modules = [{ id: 'missing-module', enabled: true, required: false }];
  const optional = new ModuleLoader(item, state, createLogger({ test: true }), lockPath, storage);
  await optional.start(); await optional.stop();
  item.modules[0].required = true;
  const required = new ModuleLoader(item, state, createLogger({ test: true }), lockPath, storage);
  await assert.rejects(required.start(), /Required module missing-module/);
  await storage.close(); await rm(root, { recursive: true, force: true });
});

test('capabilities require every standard launcher endpoint', async () => {
  const routers = new RouterRegistry();
  const moduleRouter = routers.create('distribution');
  moduleRouter.add('GET', '/launcher/news', () => ({ body: { items: [] } }));
  moduleRouter.add('GET', '/launcher/client/manifest', () => ({ body: { version: 'test' } }));

  assert.equal(routers.hasLauncherCapability('news'), true);
  assert.equal(routers.hasLauncherCapability('clientDistribution'), false);

  moduleRouter.add('GET', '/launcher/client/download', () => ({ body: { archive: true } }));
  assert.equal(routers.hasLauncherCapability('clientDistribution'), true);
  assert.deepEqual(
    await routers.dispatchLauncher('/launcher/client/manifest', {
      method: 'GET',
      path: '/api/launcher/servers/test/client/manifest',
      headers: {},
      body: {},
    }),
    { body: { version: 'test' } },
  );
});
