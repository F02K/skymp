import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyManagedServerEnvironment } from '../ts/managedSettings.mjs';
import { portableManagedServerSettings } from '../../scripts/managed-server-settings.mjs';

test('managed environment disables offline mode and updates the complete settings object', () => {
  const source = {
    backend: { url: 'http://127.0.0.1:1', serverId: 'legacy', tokenEnv: 'OLD_TOKEN' },
    dataDir: './legacy-data',
    gamemodePath: './legacy-gamemode.js',
    loadOrder: ['F:/Steam/Skyrim.esm'],
    master: '',
    maxPlayers: 20,
    name: 'Legacy',
    offlineMode: true,
    port: 7777,
  };
  const result = applyManagedServerEnvironment(source, {
    SKYMP_BACKEND_URL: 'http://127.0.0.1:3001',
    SKYMP_BACKEND_SERVER_ID: 'managed',
    SKYMP_BACKEND_TOKEN_ENV: 'MANAGED_TOKEN',
    SKYMP_SERVER_NAME: 'Managed Server',
    SKYMP_SERVER_MAX_PLAYERS: '42',
    SKYMP_SERVER_PORT: '7000',
    SKYMP_GAMEMODE_PATH: './gamemode.js',
    SKYMP_DATA_DIRECTORY: './data',
    SKYMP_LOAD_ORDER: '["Skyrim.esm","Update.esm"]',
  });

  assert.equal(result.managed, true);
  assert.equal(result.settings.offlineMode, false);
  assert.equal(result.settings.master, undefined);
  assert.deepEqual(result.settings.backend, {
    url: 'http://127.0.0.1:3001',
    serverId: 'managed',
    tokenEnv: 'MANAGED_TOKEN',
  });
  assert.deepEqual(result.settings.loadOrder, ['Skyrim.esm', 'Update.esm']);
  assert.equal(result.settings.dataDir, './data');
  assert.equal(result.settings.gamemodePath, './gamemode.js');
  assert.equal(result.settings.maxPlayers, 42);
  assert.equal(result.settings.port, 7000);
  assert.equal(source.offlineMode, true);
  assert.deepEqual(source.loadOrder, ['F:/Steam/Skyrim.esm']);
});

test('managed backend variables are atomic and absolute load-order paths remain supported', () => {
  assert.throws(
    () => applyManagedServerEnvironment({}, { SKYMP_BACKEND_URL: 'http://127.0.0.1:3001' }),
    /require SKYMP_BACKEND_URL.*SKYMP_BACKEND_SERVER_ID.*SKYMP_BACKEND_TOKEN_ENV/u,
  );
  const absolute = 'F:/Steam/steamapps/common/Skyrim Special Edition/Data/Skyrim.esm';
  const result = applyManagedServerEnvironment({}, { SKYMP_LOAD_ORDER: JSON.stringify([absolute]) });
  assert.deepEqual(result.settings.loadOrder, [absolute]);
  assert.throws(
    () => applyManagedServerEnvironment({}, { SKYMP_CLIENT_PACK_VERSION: '1.0.0' }),
    /must be supplied together/u,
  );
  const pack = applyManagedServerEnvironment({}, {
    SKYMP_CLIENT_PACK_VERSION: '1.0.0',
    SKYMP_CLIENT_PACK_MANIFEST_SHA256: 'a'.repeat(64),
  });
  assert.deepEqual(pack.settings.clientPack, {
    version: '1.0.0',
    manifestSha256: 'a'.repeat(64),
    clientApiVersion: 1,
  });
});

test('managed package baseline removes build-machine paths without changing its source', () => {
  const source = {
    backend: { url: 'http://127.0.0.1:3001' },
    dataDir: 'F:/Steam/Data',
    gamemodePath: 'E:/Checkout/gamemode.js',
    loadOrder: ['F:/Steam/Data/Skyrim.esm'],
    master: '',
    offlineMode: true,
  };
  const portable = portableManagedServerSettings(source);
  assert.deepEqual(portable.loadOrder, []);
  assert.equal(portable.dataDir, './data');
  assert.equal(portable.gamemodePath, './gamemode.js');
  assert.equal(portable.offlineMode, false);
  assert.equal(portable.backend, undefined);
  assert.equal(portable.master, undefined);
  assert.deepEqual(source.loadOrder, ['F:/Steam/Data/Skyrim.esm']);
});
