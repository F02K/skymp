import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { BackendConfig } from './types.js';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Invalid backend config: ${message}`);
}

function positiveInteger(value: unknown, field: string): asserts value is number {
  assert(Number.isInteger(value) && Number(value) > 0, `${field} must be a positive integer`);
}

export function loadConfig(path = 'backend.config.json'): BackendConfig {
  const absolutePath = resolve(path);
  const config = JSON.parse(readFileSync(absolutePath, 'utf8')) as BackendConfig;
  validateConfig(config);
  const root = dirname(absolutePath);
  config.supervisor.cwd = resolve(root, config.supervisor.cwd);
  if (config.database.path) config.database.path = resolve(root, config.database.path);
  return config;
}

export function validateConfig(config: BackendConfig): void {
  assert(config && typeof config === 'object', 'root must be an object');
  for (const [name, listener] of [
    ['publicApi', config.publicApi],
    ['internalApi', config.internalApi],
  ] as const) {
    assert(listener && typeof listener.host === 'string', `${name}.host is required`);
    positiveInteger(listener.port, `${name}.port`);
    assert(listener.port <= 65535, `${name}.port must be <= 65535`);
  }
  assert(
    config.publicApi.host !== config.internalApi.host || config.publicApi.port !== config.internalApi.port,
    'publicApi and internalApi must use separate listeners',
  );
  assert(
    ['127.0.0.1', '::1', 'localhost'].includes(config.internalApi.host),
    'internalApi.host must be loopback-only',
  );
  assert(config.database?.adapter === 'sqlite' || config.database?.adapter === 'postgres', 'database.adapter must be sqlite or postgres');
  assert(config.database.adapter !== 'sqlite' || Boolean(config.database.path), 'database.path is required for sqlite');
  assert(!('masterKeyEnv' in (config.server ?? {})), 'server.masterKeyEnv is unsupported; use server.internalTokenEnv');
  assert(!('issuerTokenEnv' in (config.sessions ?? {})), 'sessions.issuerTokenEnv is unsupported; sessions are issued only from Directory grants');
  assert(Boolean(config.server?.id), 'server.id is required');
  assert(Boolean(config.server?.internalTokenEnv), 'server.internalTokenEnv is required');
  assert(Boolean(config.server?.name), 'server.name is required');
  const address = config.server?.gameAddress?.match(/^(?:\[[^\]]+]|[^:]+):(\d+)$/);
  assert(address && Number(address[1]) >= 1 && Number(address[1]) <= 65535, 'server.gameAddress must be host:port with a valid port');
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
