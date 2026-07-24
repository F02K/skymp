import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { applyBackendEnvironment, attemptAutomaticPortMapping, discoverPlugins, ensureBackendConfig, normalizeLoadOrder, portForwardingInstructions, resolvePluginNames } from '../dist/setup.js';

test('non-interactive first-run setup writes final config without backend credentials', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skymp-setup-'));
  await mkdir(join(root, 'backend'));
  await writeFile(join(root, 'backend', 'backend.config.example.json'), await readFile('backend.config.example.json'));
  const target = join(root, 'backend.config.json');
  await ensureBackendConfig(target, {
    environment: {
      SKYMP_SERVER_NAME: 'Environment Server',
      SKYMP_GAME_PORT: '7000',
      SKYMP_RESOURCES_PORT: '7001',
      SKYMP_DIRECTORY_URL: 'https://directory.example',
    },
    input: new PassThrough(), output: new PassThrough(),
  });
  const created = JSON.parse(await readFile(target, 'utf8'));
  assert.equal(created.server.gamePort, 7000);
  assert.equal(created.server.resourcesPort, 7001);
  assert.equal(created.server.publicBackendUrl, undefined);
  assert.equal(
    created.modules.find((module) => module.id === 'directory-connector').config.credentialEnv,
    undefined,
  );
  assert.equal(created.server.id, undefined);
  assert.equal(created.modules[0].config.url, 'https://directory.example');
  await rm(root, { recursive: true, force: true });
});

test('config updates preserve unknown settings and create backup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skymp-setup-update-'));
  const target = join(root, 'backend.config.json');
  const template = JSON.parse(await readFile('backend.config.example.json', 'utf8'));
  template.server.name = 'Existing';
  template.server.publicBackendUrl = 'https://legacy.example';
  template.modules.find((module) => module.id === 'directory-connector').config.credentialEnv = 'LEGACY_DIRECTORY_SECRET';
  template.customOperatorSetting = { keep: true };
  await writeFile(target, JSON.stringify(template));
  await ensureBackendConfig(target, {
    force: true,
    environment: { SKYMP_SERVER_NAME: 'Updated' },
    input: new PassThrough(), output: new PassThrough(),
  });
  const updated = JSON.parse(await readFile(target, 'utf8'));
  assert.deepEqual(updated.customOperatorSetting, { keep: true });
  assert.equal(updated.server.publicBackendUrl, undefined);
  assert.equal(updated.modules.find((module) => module.id === 'directory-connector').config.credentialEnv, undefined);
  const files = await (await import('node:fs/promises')).readdir(root);
  assert.ok(files.some((name) => name.startsWith('backend.config.json.bak-')));
  await rm(root, { recursive: true, force: true });
});

test('plugin scan recognizes ESM ESP ESL and ignores archives', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skymp-plugins-'));
  await Promise.all(['A.esm', 'B.ESP', 'C.esl', 'mod.zip'].map((name) => writeFile(join(root, name), 'x')));
  assert.deepEqual(await discoverPlugins(root), ['A.esm', 'B.ESP', 'C.esl']);
  await rm(root, { recursive: true, force: true });
});

test('plugin selection is case-insensitive and preserves an explicit load order', () => {
  const discovered = ['Skyrim.esm', 'Example.esp', 'Optional.esl'];
  assert.deepEqual(resolvePluginNames(['skyrim.ESM', 'example.ESP'], discovered), [
    'Skyrim.esm',
    'Example.esp',
  ]);
  assert.deepEqual(
    normalizeLoadOrder(['Example.esp'], ['Skyrim.esm', 'Example.esp']),
    ['Example.esp', 'Skyrim.esm'],
  );
  assert.throws(() => resolvePluginNames(['missing.esp'], discovered), /was not found/);
});

test('environment overrides and fallback instructions contain only game/resources ports', () => {
  const config = JSON.parse(JSON.stringify({
    server: { name: 'x', description: '', region: 'eu', tags: [], gamePort: 7777, resourcesPort: 7778, gamemode: 'default', dataDirectory: './data', plugins: [], loadOrder: [], maxPlayers: 10, visibility: 'public' },
    modules: [{ id: 'directory-connector', enabled: true, required: true, config: {} }],
  }));
  applyBackendEnvironment(config, { SKYMP_SERVER_TAGS: 'one, two', SKYMP_SERVER_MAX_PLAYERS: '42' });
  assert.deepEqual(config.server.tags, ['one', 'two']);
  assert.equal(config.server.maxPlayers, 42);
  assert.match(portForwardingInstructions(config), /UDP 7777/);
  assert.match(portForwardingInstructions(config), /TCP 7778/);
  assert.doesNotMatch(portForwardingInstructions(config), /3001/);
});

test('UPnP falls back to NAT-PMP and reports failure for exact UDP/TCP mappings', async () => {
  const config = { server: { gamePort: 7777, resourcesPort: 7778 } };
  const calls = [];
  const result = await attemptAutomaticPortMapping(config, async (command, args) => {
    calls.push([command, ...args]);
    return command === 'natpmpc' && args[2] === 'udp';
  });
  assert.equal(result, false);
  assert.deepEqual(calls.map((item) => [item[0], item.at(-2)]), [
    ['upnpc', '7777'],
    ['natpmpc', 'udp'],
    ['upnpc', '7778'],
    ['natpmpc', 'tcp'],
  ]);
});
