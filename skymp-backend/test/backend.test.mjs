import assert from 'node:assert/strict';
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

function config(root) {
  return {
    publicApi: { host: '127.0.0.1', port: 0 }, internalApi: { host: '127.0.0.1', port: 0 },
    database: { adapter: 'sqlite', path: join(root, 'backend.sqlite') },
    server: { id: 'test', masterKeyEnv: 'TEST_MASTER', name: 'Test', description: '', region: 'test', tags: [], publicBackendUrl: 'http://127.0.0.1', gameAddress: '127.0.0.1:7777', maxPlayers: 10, visibility: 'private' },
    supervisor: { command: process.execPath, args: [], cwd: root, readyTimeoutMs: 3000, shutdownTimeoutMs: 1000, restart: { enabled: false, initialDelayMs: 10, maxDelayMs: 100, maxAttempts: 2, windowMs: 1000 } },
    sessions: { issuerTokenEnv: 'TEST_ISSUER', ttlSeconds: 60 }, modules: [],
  };
}

test('configuration keeps the internal API loopback-only and secrets are redacted', () => {
  const item = config('.'); item.publicApi.port = 3000; item.internalApi.port = 3001; item.internalApi.host = '0.0.0.0';
  assert.throws(() => validateConfig(item), /loopback-only/);
  assert.deepEqual(sanitize({ credential: 'secret', nested: { masterKey: 'value' }, safe: 'ok' }), { credential: '[REDACTED]', nested: { masterKey: '[REDACTED]' }, safe: 'ok' });
});

test('legacy SkyMP heartbeat and session validation use only the internal listener', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skymp-backend-api-'));
  const item = config(root); const storage = new SqliteStorage(item.database.path); await storage.migrate();
  const state = new RuntimeState(10); const logger = createLogger({ test: true });
  const apis = await startApis({ config: item, storage, state, logger, masterKey: 'master', issuerToken: 'issuer-token', routers: new RouterRegistry() });
  const publicPort = apis.publicServer.address().port; const internalPort = apis.internalServer.address().port;
  const issued = await fetch(`http://127.0.0.1:${publicPort}/api/v2/auth/sessions`, { method: 'POST', headers: { authorization: 'Bearer issuer-token', 'content-type': 'application/json' }, body: JSON.stringify({ userId: '42', username: 'Player', roles: ['member'] }) });
  assert.equal(issued.status, 201); const session = await issued.json();
  const valid = await fetch(`http://127.0.0.1:${internalPort}/api/servers/master/sessions/${session.token}`);
  assert.equal(valid.status, 200); assert.equal((await valid.json()).user.username, 'Player');
  const heartbeat = await fetch(`http://127.0.0.1:${internalPort}/api/servers/master`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ online: 3, maxPlayers: 10 }) });
  assert.equal(heartbeat.status, 200); assert.equal(state.get().online, 3);
  assert.equal((await fetch(`http://127.0.0.1:${publicPort}/api/servers/master/sessions/${session.token}`)).status, 404);
  await Promise.all([stopServer(apis.publicServer), stopServer(apis.internalServer)]); await storage.close(); await rm(root, { recursive: true, force: true });
});

test('supervisor waits for a real heartbeat and shuts down its child', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skymp-supervisor-')); const item = config(root);
  const storage = new SqliteStorage(item.database.path); await storage.migrate(); const state = new RuntimeState(10);
  const apis = await startApis({ config: item, storage, state, logger: createLogger({ test: true }), masterKey: 'master', issuerToken: 'issuer-token', routers: new RouterRegistry() });
  const port = apis.internalServer.address().port;
  item.supervisor.args = ['-e', `setInterval(()=>fetch('http://127.0.0.1:${port}/api/servers/master',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({online:1,maxPlayers:10})}),50)`];
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
  await module.start({ config: { url: 'http://127.0.0.1:1', serverId: 'test', credentialEnv: 'TEST_DIRECTORY_CREDENTIAL', heartbeatIntervalMs: 10000 }, logger: createLogger({ test: true }), events: state, getStatus: () => state.get(), getSecret: (name) => process.env[name], services: new Map(), router: { add() {} }, database: { get: async () => null, set: async () => {}, delete: async () => {}, migrate: async () => {} } });
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
