import { randomBytes } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import type { BackendConfig } from './types.js';
import { applyBackendEnvironment } from './setup.js';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Invalid backend config: ${message}`);
}

function positiveInteger(value: unknown, field: string): asserts value is number {
  assert(Number.isInteger(value) && Number(value) > 0, `${field} must be a positive integer`);
}

export function loadConfig(path = 'backend.config.json'): BackendConfig {
  const absolutePath = resolve(path);
  const config = applyBackendEnvironment(JSON.parse(readFileSync(absolutePath, 'utf8')) as BackendConfig);
  validateConfig(config);
  const root = dirname(absolutePath);
  config.supervisor.cwd = resolve(root, config.supervisor.cwd);
  if (config.database.path) config.database.path = resolve(root, config.database.path);
  if (config.server.gamemode === 'default') config.server.gamemode = './gamemode.js';
  config.server.gamemode = resolve(root, config.server.gamemode);
  config.server.dataDirectory = resolve(root, config.server.dataDirectory);
  if (config.server.clientPack) {
    config.server.clientPack.archive = resolve(root, config.server.clientPack.archive);
  }
  return config;
}

export function validateRuntimePaths(config: BackendConfig): void {
  requirePath(config.server.dataDirectory, 'server.dataDirectory', true);
  requirePath(config.server.gamemode, 'server.gamemode');
  for (const entry of config.server.loadOrder) {
    const path = isAbsolute(entry) ? entry : resolve(config.server.dataDirectory, entry);
    requirePath(path, `server.loadOrder entry ${entry}`);
  }
  if (config.server.clientPack) {
    requirePath(config.server.clientPack.archive, 'server.clientPack.archive');
  }
}

export function validateConfig(config: BackendConfig): void {
  assert(config && typeof config === 'object', 'root must be an object');
  const listener = config.internalApi;
  assert(listener && typeof listener.host === 'string', 'internalApi.host is required');
  positiveInteger(listener.port, 'internalApi.port');
  assert(listener.port <= 65535, 'internalApi.port must be <= 65535');
  assert(
    ['127.0.0.1', '::1', 'localhost'].includes(config.internalApi.host),
    'internalApi.host must be loopback-only',
  );
  assert(config.database?.adapter === 'sqlite' || config.database?.adapter === 'postgres', 'database.adapter must be sqlite or postgres');
  assert(config.database.adapter !== 'sqlite' || Boolean(config.database.path), 'database.path is required for sqlite');
  assert(!('masterKeyEnv' in (config.server ?? {})), 'server.masterKeyEnv is unsupported; use server.internalTokenEnv');
  assert(!('issuerTokenEnv' in (config.sessions ?? {})), 'sessions.issuerTokenEnv is unsupported; sessions are issued only from Directory grants');
  const directory = config.modules?.find((module) => module.id === 'directory-connector' && module.enabled);
  const autoRegister = directory?.config?.autoRegister !== false;
  assert(Boolean(config.server?.id) || Boolean(directory && autoRegister), 'server.id is required unless directory-connector autoRegister is enabled');
  assert(Boolean(config.server?.internalTokenEnv), 'server.internalTokenEnv is required');
  assert(Boolean(config.server?.name), 'server.name is required');
  positiveInteger(config.server.gamePort, 'server.gamePort');
  assert(config.server.gamePort <= 65535, 'server.gamePort must be <= 65535');
  positiveInteger(config.server.resourcesPort, 'server.resourcesPort');
  assert(config.server.resourcesPort <= 65535, 'server.resourcesPort must be <= 65535');
  assert(Boolean(config.server.gamemode), 'server.gamemode is required');
  assert(Boolean(config.server.dataDirectory), 'server.dataDirectory is required');
  assert(Array.isArray(config.server.plugins), 'server.plugins must be an array');
  assert(Array.isArray(config.server.loadOrder), 'server.loadOrder must be an array');
  if (config.server.modpack) {
    assert(Boolean(config.server.modpack.nexusCollection), 'server.modpack.nexusCollection is required');
    positiveInteger(config.server.modpack.revision, 'server.modpack.revision');
  }
  if (config.server.clientPack) {
    assert(Boolean(config.server.clientPack.archive), 'server.clientPack.archive is required');
    assert(Boolean(config.server.clientPack.host), 'server.clientPack.host is required');
    positiveInteger(config.server.clientPack.port, 'server.clientPack.port');
    assert(config.server.clientPack.port <= 65535, 'server.clientPack.port must be <= 65535');
    assert(![
      config.internalApi.port,
      config.server.gamePort,
      config.server.resourcesPort,
    ].includes(config.server.clientPack.port), 'server.clientPack.port must be distinct from internal, game and resources ports');
  }
  assert(Boolean(config.supervisor?.command), 'supervisor.command is required');
  assert(Array.isArray(config.supervisor?.args), 'supervisor.args must be an array');
  assert(Boolean(config.supervisor?.cwd), 'supervisor.cwd is required');
  positiveInteger(config.supervisor.readyTimeoutMs, 'supervisor.readyTimeoutMs');
  positiveInteger(config.supervisor.shutdownTimeoutMs, 'supervisor.shutdownTimeoutMs');
  positiveInteger(config.supervisor.restart.maxAttempts, 'supervisor.restart.maxAttempts');
  positiveInteger(config.sessions?.ttlSeconds, 'sessions.ttlSeconds');
  if (config.sessions.directoryPublicKey) {
    let decoded: Buffer;
    try { decoded = Buffer.from(config.sessions.directoryPublicKey, 'base64'); } catch { decoded = Buffer.alloc(0); }
    assert(decoded.length > 32, 'sessions.directoryPublicKey must be a base64-encoded Ed25519 SPKI key');
  }
  const guild = config.server.access?.discordGuild;
  if (guild?.required) assert(Boolean(guild.guildId && /^\d{5,30}$/.test(guild.guildId)), 'server.access.discordGuild.guildId is required');
  if (guild?.inviteUrl) {
    let invite: URL;
    try { invite = new URL(guild.inviteUrl); } catch { throw new Error('Invalid backend config: server.access.discordGuild.inviteUrl is invalid'); }
    assert(invite.protocol === 'https:' && ['discord.gg', 'discord.com'].includes(invite.hostname), 'server.access.discordGuild.inviteUrl must use discord.gg or discord.com');
  }
  assert(Array.isArray(config.modules), 'modules must be an array');
  const ids = config.modules.map((module) => module.id);
  assert(new Set(ids).size === ids.length, 'module IDs must be unique');
}

export function requireSecret(envName: string): string {
  const value = process.env[envName];
  if (!value) throw new Error(`Required secret environment variable ${envName} is not set`);
  return value;
}

export function ensureInternalToken(
  envName: string,
  environment: NodeJS.ProcessEnv = process.env,
): { value: string; generated: boolean } {
  const existing = environment[envName];
  if (existing) return { value: existing, generated: false };
  const value = randomBytes(32).toString('base64url');
  environment[envName] = value;
  return { value, generated: true };
}

function requirePath(path: string, field: string, directory = false): void {
  let details;
  try {
    details = statSync(path);
  } catch {
    throw new Error(`Invalid backend config: ${field} does not exist at ${path}`);
  }
  if (directory ? !details.isDirectory() : !details.isFile() && !details.isDirectory()) {
    throw new Error(`Invalid backend config: ${field} has the wrong file type at ${path}`);
  }
}
