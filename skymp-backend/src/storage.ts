import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import type { BackendConfig, SessionRecord, Storage } from './types.js';

const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');

export class SqliteStorage implements Storage {
  private readonly database: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.database = new DatabaseSync(path);
  }

  async migrate(): Promise<void> {
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        username TEXT NOT NULL,
        discord_id TEXT,
        roles_json TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        profile_id INTEGER
      );
      CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
      CREATE TABLE IF NOT EXISTS module_kv (
        namespace TEXT NOT NULL, key TEXT NOT NULL, value_json TEXT NOT NULL,
        PRIMARY KEY(namespace, key)
      );
      CREATE TABLE IF NOT EXISTS profiles (
        profile_id INTEGER PRIMARY KEY AUTOINCREMENT,
        discord_id TEXT UNIQUE NOT NULL, username TEXT NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS consumed_grants (
        jti TEXT PRIMARY KEY, expires_at INTEGER NOT NULL
      );
    `);
    const sessionColumns = this.database.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>;
    if (!sessionColumns.some((column) => column.name === 'profile_id')) this.database.exec('ALTER TABLE sessions ADD COLUMN profile_id INTEGER');
  }

  async getSession(token: string): Promise<SessionRecord | null> {
    const row = this.database.prepare(
      'SELECT user_id, username, discord_id, roles_json, expires_at, profile_id FROM sessions WHERE token_hash = ?',
    ).get(tokenHash(token)) as Record<string, unknown> | undefined;
    if (!row || Number(row.expires_at) <= Date.now()) {
      if (row) this.database.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash(token));
      return null;
    }
    return {
      token,
      userId: String(row.user_id),
      username: String(row.username),
      discordId: row.discord_id ? String(row.discord_id) : undefined,
      roles: JSON.parse(String(row.roles_json)) as string[],
      expiresAt: Number(row.expires_at),
      profileId: Number(row.profile_id ?? row.user_id),
    };
  }

  async putSession(record: SessionRecord): Promise<void> {
    this.database.prepare(`
      INSERT INTO sessions(token_hash, user_id, username, discord_id, roles_json, expires_at, profile_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(token_hash) DO UPDATE SET
        user_id=excluded.user_id, username=excluded.username,
        discord_id=excluded.discord_id, roles_json=excluded.roles_json,
        expires_at=excluded.expires_at, profile_id=excluded.profile_id
    `).run(tokenHash(record.token), record.userId, record.username, record.discordId ?? null, JSON.stringify(record.roles), record.expiresAt, record.profileId);
  }

  async revokeSession(token: string): Promise<void> {
    this.database.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash(token));
  }
  async getOrCreateProfile(discordId: string, username: string): Promise<number> {
    this.database.prepare(`INSERT INTO profiles(discord_id,username,updated_at) VALUES(?,?,?)
      ON CONFLICT(discord_id) DO UPDATE SET username=excluded.username,updated_at=excluded.updated_at`).run(discordId, username, Date.now());
    const row = this.database.prepare('SELECT profile_id FROM profiles WHERE discord_id=?').get(discordId) as { profile_id: number };
    return Number(row.profile_id);
  }
  async consumeGrant(jti: string, expiresAt: number): Promise<boolean> {
    this.database.prepare('DELETE FROM consumed_grants WHERE expires_at<=?').run(Date.now());
    try { this.database.prepare('INSERT INTO consumed_grants VALUES(?,?)').run(jti, expiresAt); return true; }
    catch (cause) { if (cause instanceof Error && /UNIQUE|constraint/i.test(cause.message)) return false; throw cause; }
  }
  async getModuleValue(namespace: string, key: string): Promise<unknown> {
    const row = this.database.prepare('SELECT value_json FROM module_kv WHERE namespace=? AND key=?').get(namespace, key) as { value_json: string } | undefined;
    return row ? JSON.parse(row.value_json) : null;
  }
  async putModuleValue(namespace: string, key: string, value: unknown): Promise<void> {
    this.database.prepare(`INSERT INTO module_kv(namespace,key,value_json) VALUES(?,?,?)
      ON CONFLICT(namespace,key) DO UPDATE SET value_json=excluded.value_json`).run(namespace, key, JSON.stringify(value));
  }
  async deleteModuleValue(namespace: string, key: string): Promise<void> {
    this.database.prepare('DELETE FROM module_kv WHERE namespace=? AND key=?').run(namespace, key);
  }

  async close(): Promise<void> { this.database.close(); }
}

class PostgresStorage implements Storage {
  private pool: any;
  constructor(connectionString: string) {
    const require = createRequire(import.meta.url);
    let pg: any;
    try { pg = require('pg'); }
    catch { throw new Error('PostgreSQL adapter requires the optional pg package'); }
    this.pool = new pg.Pool({ connectionString });
  }
  async migrate(): Promise<void> {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, username TEXT NOT NULL,
      discord_id TEXT, roles_json JSONB NOT NULL, expires_at BIGINT NOT NULL, profile_id INTEGER);
      ALTER TABLE sessions ADD COLUMN IF NOT EXISTS profile_id INTEGER;
      CREATE TABLE IF NOT EXISTS profiles (
        profile_id SERIAL PRIMARY KEY, discord_id TEXT UNIQUE NOT NULL, username TEXT NOT NULL, updated_at BIGINT NOT NULL);
      CREATE TABLE IF NOT EXISTS consumed_grants (jti TEXT PRIMARY KEY, expires_at BIGINT NOT NULL);
      CREATE TABLE IF NOT EXISTS module_kv (
        namespace TEXT NOT NULL, key TEXT NOT NULL, value_json JSONB NOT NULL,
        PRIMARY KEY(namespace, key))`);
  }
  async getSession(token: string): Promise<SessionRecord | null> {
    const result = await this.pool.query('SELECT * FROM sessions WHERE token_hash = $1 AND expires_at > $2', [tokenHash(token), Date.now()]);
    const row = result.rows[0];
    if (!row) return null;
    return { token, userId: row.user_id, username: row.username, discordId: row.discord_id ?? undefined, roles: row.roles_json, expiresAt: Number(row.expires_at), profileId: Number(row.profile_id ?? row.user_id) };
  }
  async putSession(record: SessionRecord): Promise<void> {
    await this.pool.query(`INSERT INTO sessions(token_hash,user_id,username,discord_id,roles_json,expires_at,profile_id) VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT(token_hash) DO UPDATE SET user_id=$2,username=$3,discord_id=$4,roles_json=$5,expires_at=$6,profile_id=$7`,
    [tokenHash(record.token), record.userId, record.username, record.discordId ?? null, JSON.stringify(record.roles), record.expiresAt, record.profileId]);
  }
  async revokeSession(token: string): Promise<void> { await this.pool.query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash(token)]); }
  async getOrCreateProfile(discordId: string, username: string): Promise<number> {
    const result = await this.pool.query(`INSERT INTO profiles(discord_id,username,updated_at) VALUES($1,$2,$3)
      ON CONFLICT(discord_id) DO UPDATE SET username=$2,updated_at=$3 RETURNING profile_id`, [discordId, username, Date.now()]);
    return Number(result.rows[0].profile_id);
  }
  async consumeGrant(jti: string, expiresAt: number): Promise<boolean> {
    await this.pool.query('DELETE FROM consumed_grants WHERE expires_at <= $1', [Date.now()]);
    const result = await this.pool.query('INSERT INTO consumed_grants VALUES($1,$2) ON CONFLICT DO NOTHING', [jti, expiresAt]);
    return result.rowCount === 1;
  }
  async getModuleValue(namespace: string, key: string): Promise<unknown> {
    const result = await this.pool.query('SELECT value_json FROM module_kv WHERE namespace=$1 AND key=$2', [namespace, key]);
    return result.rows[0]?.value_json ?? null;
  }
  async putModuleValue(namespace: string, key: string, value: unknown): Promise<void> {
    await this.pool.query(`INSERT INTO module_kv(namespace,key,value_json) VALUES($1,$2,$3)
      ON CONFLICT(namespace,key) DO UPDATE SET value_json=$3`, [namespace, key, JSON.stringify(value)]);
  }
  async deleteModuleValue(namespace: string, key: string): Promise<void> { await this.pool.query('DELETE FROM module_kv WHERE namespace=$1 AND key=$2', [namespace, key]); }
  async close(): Promise<void> { await this.pool.end(); }
}

export function createStorage(config: BackendConfig['database']): Storage {
  if (config.adapter === 'sqlite') return new SqliteStorage(config.path!);
  const envName = config.connectionStringEnv ?? 'DATABASE_URL';
  const connectionString = process.env[envName];
  if (!connectionString) throw new Error(`Required PostgreSQL connection variable ${envName} is not set`);
  return new PostgresStorage(connectionString);
}
