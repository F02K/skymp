import { constants } from 'node:fs';
import { access, copyFile, mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import type { BackendConfig } from './types.js';

interface SetupOptions {
  force?: boolean;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  environment?: NodeJS.ProcessEnv;
}

export async function ensureBackendConfig(path: string, options: SetupOptions = {}): Promise<boolean> {
  const absolutePath = resolve(path);
  const exists = await access(absolutePath, constants.F_OK).then(() => true, () => false);
  if (exists && !options.force) return false;

  const environment = options.environment ?? process.env;
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const template = exists
    ? JSON.parse(await readFile(absolutePath, 'utf8')) as BackendConfig
    : await loadTemplate(absolutePath);
  migrateRemovedSettings(template as BackendConfig & Record<string, unknown>);
  applyBackendEnvironment(template, environment);

  const interactive = environment.SKYMP_SETUP_INTERACTIVE === '1'
    || Boolean((input as NodeJS.ReadStream).isTTY && (output as NodeJS.WriteStream).isTTY);
  if (interactive) await promptForServer(template, input, output);
  else assertNonInteractiveValues(template, environment);

  const configDirectory = dirname(absolutePath);
  if (environment.SKYMP_MOD_SOURCE_DIRECTORY) {
    await copyServerMods(environment.SKYMP_MOD_SOURCE_DIRECTORY, resolve(configDirectory, template.server.dataDirectory));
  }
  const dataDirectory = resolve(configDirectory, template.server.dataDirectory);
  await mkdir(dataDirectory, { recursive: true });
  const discoveredPlugins = await discoverPlugins(dataDirectory);
  if (template.server.modCollectionLock) {
    template.server.plugins = [];
    template.server.loadOrder = [];
    output.write('Plugin selection and load order will be read from the ModCollection lock.\n');
  } else if (interactive) {
    await promptForPlugins(template, discoveredPlugins, input, output);
  } else {
    template.server.plugins = discoveredPlugins;
    template.server.loadOrder = normalizeLoadOrder(template.server.loadOrder, discoveredPlugins);
  }

  await mkdir(configDirectory, { recursive: true });
  if (exists) {
    const backup = `${absolutePath}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    await copyFile(absolutePath, backup);
    output.write(`Backup written to ${backup}\n`);
  }
  const temporary = `${absolutePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, `${JSON.stringify(template, null, 2)}\n`, { flag: 'wx' });
  await rename(temporary, absolutePath);
  output.write(`Managed server configuration written to ${absolutePath}\n`);
  if (template.network?.autoMapPorts) {
    const mapped = await attemptAutomaticPortMapping(template);
    output.write(mapped
      ? 'Automatic UPnP/NAT-PMP port mapping succeeded.\n'
      : 'Automatic UPnP/NAT-PMP port mapping was unavailable.\n');
  }
  output.write(portForwardingInstructions(template));
  return true;
}

export function applyBackendEnvironment(
  config: BackendConfig,
  environment: NodeJS.ProcessEnv = process.env,
): BackendConfig {
  if (environment.SKYMP_SERVER_NAME) config.server.name = environment.SKYMP_SERVER_NAME;
  if (environment.SKYMP_SERVER_DESCRIPTION) config.server.description = environment.SKYMP_SERVER_DESCRIPTION;
  if (environment.SKYMP_SERVER_REGION) config.server.region = environment.SKYMP_SERVER_REGION;
  if (environment.SKYMP_SERVER_TAGS) {
    config.server.tags = environment.SKYMP_SERVER_TAGS.split(',').map((item) => item.trim()).filter(Boolean);
  }
  if (environment.SKYMP_GAME_PORT) config.server.gamePort = parsePort(environment.SKYMP_GAME_PORT, 'SKYMP_GAME_PORT');
  if (environment.SKYMP_RESOURCES_PORT) config.server.resourcesPort = parsePort(environment.SKYMP_RESOURCES_PORT, 'SKYMP_RESOURCES_PORT');
  const clientPackValues = [
    environment.SKYMP_CLIENT_PACK_ARCHIVE,
    environment.SKYMP_CLIENT_PACK_PORT,
  ];
  if (clientPackValues.some(Boolean)) {
    if (!clientPackValues.every(Boolean)) {
      throw new Error('SKYMP_CLIENT_PACK_ARCHIVE and SKYMP_CLIENT_PACK_PORT must be supplied together');
    }
    config.server.clientPack = {
      archive: environment.SKYMP_CLIENT_PACK_ARCHIVE!,
      host: '0.0.0.0',
      port: parsePort(environment.SKYMP_CLIENT_PACK_PORT!, 'SKYMP_CLIENT_PACK_PORT'),
    };
  }
  if (environment.SKYMP_SERVER_HOSTNAME) config.server.hostname = environment.SKYMP_SERVER_HOSTNAME;
  if (environment.SKYMP_GAMEMODE) config.server.gamemode = environment.SKYMP_GAMEMODE;
  if (environment.SKYMP_DATA_DIRECTORY) config.server.dataDirectory = environment.SKYMP_DATA_DIRECTORY;
  if (environment.SKYMP_SERVER_VISIBILITY) {
    if (!['public', 'private'].includes(environment.SKYMP_SERVER_VISIBILITY)) {
      throw new Error('SKYMP_SERVER_VISIBILITY must be public or private');
    }
    config.server.visibility = environment.SKYMP_SERVER_VISIBILITY as 'public' | 'private';
  }
  if (environment.SKYMP_SERVER_MAX_PLAYERS) {
    const value = Number(environment.SKYMP_SERVER_MAX_PLAYERS);
    if (!Number.isInteger(value) || value < 1) throw new Error('SKYMP_SERVER_MAX_PLAYERS must be a positive integer');
    config.server.maxPlayers = value;
  }
  if (environment.SKYMP_MODCOLLECTION_LOCK) {
    config.server.modCollectionLock = environment.SKYMP_MODCOLLECTION_LOCK;
  }
  if (environment.SKYMP_DIRECTORY_URL) {
    const connector = config.modules.find((module) => module.id === 'directory-connector');
    if (connector) connector.config = { ...connector.config, url: environment.SKYMP_DIRECTORY_URL };
  }
  if (environment.SKYMP_AUTO_PORT_MAPPING) {
    config.network = { autoMapPorts: environment.SKYMP_AUTO_PORT_MAPPING === '1' };
  }
  return config;
}

export async function discoverPlugins(dataDirectory: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dataDirectory, { withFileTypes: true });
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw cause;
  }
  const extensions = new Set(['.esm', '.esp', '.esl']);
  return entries
    .filter((entry) => entry.isFile() && extensions.has(extname(entry.name).toLowerCase()))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

export async function copyServerMods(sourceDirectory: string, dataDirectory: string): Promise<number> {
  const source = resolve(sourceDirectory);
  if (!(await stat(source)).isDirectory()) throw new Error(`${source} is not a directory`);
  await mkdir(dataDirectory, { recursive: true });
  let copied = 0;
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    await copyFile(join(source, entry.name), join(dataDirectory, basename(entry.name)));
    copied += 1;
  }
  return copied;
}

export function portForwardingInstructions(config: BackendConfig): string {
  const lines = [
    'Network ports:',
    `  UDP ${config.server.gamePort} -> this machine (SkyMP game traffic)`,
    `  TCP ${config.server.resourcesPort} -> this machine (optional resources)`,
  ];
  if (config.server.clientPack) {
    lines.push(`  TCP ${config.server.clientPack.port} -> this machine (public signed Client Pack)`);
  }
  lines.push('The internal managed backend listener stays on loopback and must never be forwarded.', '');
  return lines.join('\n');
}

export async function attemptAutomaticPortMapping(
  config: BackendConfig,
  run: (command: string, args: string[]) => Promise<boolean> = runMapper,
): Promise<boolean> {
  const mappings: Array<[string, 'UDP' | 'TCP']> = [
    [String(config.server.gamePort), 'UDP'],
    [String(config.server.resourcesPort), 'TCP'],
  ];
  if (config.server.clientPack) {
    mappings.push([String(config.server.clientPack.port), 'TCP']);
  }
  let allMapped = true;
  for (const [port, protocol] of mappings) {
    const upnp = await run('upnpc', ['-a', '0.0.0.0', port, port, protocol]);
    const natPmp = upnp || await run('natpmpc', ['-a', port, port, protocol.toLowerCase(), '3600']);
    allMapped &&= natPmp;
  }
  return allMapped;
}

async function runMapper(command: string, args: string[]): Promise<boolean> {
  const { execFile } = await import('node:child_process');
  return await new Promise((resolvePromise) => {
    execFile(command, args, { timeout: 8000, windowsHide: true }, (cause) => resolvePromise(!cause));
  });
}

async function loadTemplate(configPath: string): Promise<BackendConfig> {
  const candidates = [
    resolve(dirname(configPath), 'backend', 'backend.config.example.json'),
    resolve(dirname(configPath), 'backend.config.example.json'),
  ];
  for (const candidate of candidates) {
    try {
      return JSON.parse(await readFile(candidate, 'utf8')) as BackendConfig;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
    }
  }
  throw new Error(`Managed server template is missing. Expected ${candidates.join(' or ')}`);
}

async function promptForServer(
  config: BackendConfig,
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
): Promise<void> {
  output.write('SkyMP Managed Server setup\nDirectory identity and credentials are generated automatically.\n\n');
  const prompt = createInterface({ input, output });
  try {
    config.server.name = await answer(prompt, 'Server name', config.server.name || 'My SkyMP Server');
    config.server.description = await answer(prompt, 'Description', config.server.description || 'A managed SkyMP server');
    config.server.region = await answer(prompt, 'Region', config.server.region || 'eu-central');
    config.server.tags = splitList(await answer(prompt, 'Tags (comma separated)', config.server.tags.join(','), true));
    const visibility = await answer(prompt, 'Visibility (public/private)', config.server.visibility || 'public');
    if (!['public', 'private'].includes(visibility)) throw new Error('Visibility must be public or private');
    config.server.visibility = visibility as 'public' | 'private';
    config.server.maxPlayers = parsePositive(await answer(prompt, 'Player limit', String(config.server.maxPlayers)), 'Player limit');
    config.server.gamePort = parsePort(await answer(prompt, 'UDP game port', String(config.server.gamePort)), 'Game port');
    config.server.resourcesPort = parsePort(await answer(prompt, 'TCP resources port', String(config.server.resourcesPort)), 'Resources port');
    const clientPackArchive = await answer(
      prompt,
      'Client Pack ZIP (empty for none)',
      config.server.clientPack?.archive ?? '',
      true,
    );
    if (clientPackArchive) {
      const clientPackPort = parsePort(
        await answer(prompt, 'TCP Client Pack port', String(config.server.clientPack?.port ?? config.server.resourcesPort + 1)),
        'Client Pack port',
      );
      config.server.clientPack = {
        archive: clientPackArchive,
        host: '0.0.0.0',
        port: clientPackPort,
      };
    } else {
      delete config.server.clientPack;
    }
    const hostname = await answer(prompt, 'Public hostname (empty to use observed IP)', config.server.hostname ?? '', true);
    if (hostname) config.server.hostname = hostname;
    else delete config.server.hostname;
    config.server.gamemode = await answer(prompt, 'Gamemode', config.server.gamemode);
    config.server.dataDirectory = await answer(prompt, 'Dedicated Data directory', config.server.dataDirectory);
    const collectionLock = await answer(
      prompt,
      'ModCollection lock file (empty for none)',
      config.server.modCollectionLock ?? '',
      true,
    );
    if (collectionLock) config.server.modCollectionLock = collectionLock;
    else delete config.server.modCollectionLock;
    const connector = config.modules.find((module) => module.id === 'directory-connector');
    if (connector) {
      const current = String(connector.config?.url ?? 'https://skyservers.online');
      connector.config = { ...connector.config, url: await answer(prompt, 'Directory URL', current) };
    }
    const automatic = await answer(prompt, 'Try UPnP/NAT-PMP port mapping? (yes/no)', config.network?.autoMapPorts ? 'yes' : 'no');
    config.network = { autoMapPorts: /^y(?:es)?$/i.test(automatic) };
  } finally {
    prompt.close();
  }
}

async function promptForPlugins(
  config: BackendConfig,
  discovered: string[],
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
): Promise<void> {
  if (!discovered.length) {
    config.server.plugins = [];
    config.server.loadOrder = [];
    output.write('No ESM/ESP/ESL plugins were found in the Dedicated Data directory.\n');
    return;
  }
  const prompt = createInterface({ input, output });
  try {
    output.write(`Discovered plugins: ${discovered.join(', ')}\n`);
    const selectedInput = await answer(
      prompt,
      'Enabled plugins (comma separated)',
      config.server.plugins.length ? config.server.plugins.join(',') : discovered.join(','),
    );
    const selected = resolvePluginNames(splitList(selectedInput), discovered);
    const loadOrderInput = await answer(
      prompt,
      'Load order (comma separated, first to last)',
      normalizeLoadOrder(config.server.loadOrder, selected).join(','),
    );
    const loadOrder = resolvePluginNames(splitList(loadOrderInput), selected);
    if (loadOrder.length !== selected.length)
      throw new Error('Load order must contain every enabled plugin exactly once');
    config.server.plugins = selected;
    config.server.loadOrder = loadOrder;
  } finally {
    prompt.close();
  }
}

export function resolvePluginNames(requested: string[], available: string[]): string[] {
  const byName = new Map(available.map((name) => [name.toLowerCase(), name]));
  const resolved = requested.map((name) => {
    const match = byName.get(name.toLowerCase());
    if (!match) throw new Error(`Plugin was not found in the Dedicated Data directory: ${name}`);
    return match;
  });
  if (new Set(resolved.map((name) => name.toLowerCase())).size !== resolved.length)
    throw new Error('Plugin list contains duplicates');
  return resolved;
}

export function normalizeLoadOrder(loadOrder: string[], enabled: string[]): string[] {
  const enabledNames = new Map(enabled.map((name) => [name.toLowerCase(), name]));
  const preserved = loadOrder
    .map((name) => enabledNames.get(name.toLowerCase()))
    .filter((name): name is string => Boolean(name));
  const seen = new Set(preserved.map((name) => name.toLowerCase()));
  return [...preserved, ...enabled.filter((name) => !seen.has(name.toLowerCase()))];
}

async function answer(
  prompt: ReturnType<typeof createInterface>,
  label: string,
  fallback?: string,
  optional = false,
): Promise<string> {
  const entered = (await prompt.question(`${label}${fallback ? ` [${fallback}]` : ''}: `)).trim();
  const value = entered || fallback || '';
  if (!optional && !value) throw new Error(`${label} is required`);
  return value;
}

function splitList(value: string): string[] {
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

function parsePositive(value: string, field: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${field} must be a positive integer`);
  return parsed;
}

function parsePort(value: string, field: string): number {
  const port = parsePositive(value, field);
  if (port > 65535) throw new Error(`${field} must be <= 65535`);
  return port;
}

function assertNonInteractiveValues(config: BackendConfig, environment: NodeJS.ProcessEnv): void {
  const required: Array<[string, string, RegExp]> = [
    ['SKYMP_SERVER_NAME', config.server.name, /^(?:My SkyMP Server|Yet Another Server)$/i],
  ];
  const missing = required
    .filter(([name, value, placeholder]) => !environment[name] && (!value || placeholder.test(value)))
    .map(([name]) => name);
  if (!missing.length) return;
  throw new Error([
    `Managed server setup needs these environment variables: ${missing.join(', ')}`,
    'Example: SKYMP_SERVER_NAME=My SkyMP Server',
    'Optional: SKYMP_GAME_PORT=7777, SKYMP_RESOURCES_PORT=7778, SKYMP_CLIENT_PACK_ARCHIVE=./pack.zip, SKYMP_CLIENT_PACK_PORT=7779',
  ].join('\n'));
}

function migrateRemovedSettings(config: BackendConfig & Record<string, unknown>): void {
  delete config.publicApi;
  const server = config.server as BackendConfig['server'] & Record<string, unknown>;
  delete server.publicBackendUrl;
  delete server.gameAddress;
  delete server.modpack;
  if (!server.gamePort) server.gamePort = 7777;
  if (!server.resourcesPort) server.resourcesPort = 7778;
  if (!server.gamemode || server.gamemode === 'default') server.gamemode = './gamemode.js';
  if (!server.dataDirectory) server.dataDirectory = './data';
  if (!Array.isArray(server.plugins)) server.plugins = [];
  if (!Array.isArray(server.loadOrder)) server.loadOrder = [];
  const connector = config.modules?.find((module) => module.id === 'directory-connector');
  if (connector?.config) {
    delete connector.config.credentialEnv;
    delete connector.config.credential;
    delete connector.config.pairingCode;
    delete connector.config.hmacSecret;
  }
}
