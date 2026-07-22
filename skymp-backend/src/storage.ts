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
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
      CREATE TABLE IF NOT EXISTS module_kv (
        namespace TEXT NOT NULL, key TEXT NOT NULL, value_json TEXT NOT NULL,
        PRIMARY KEY(namespace, key)
      );
    `);
  }

  async getSession(token: string): Promise<SessionRecord | null> {
    const row = this.database.prepare(
      'SELECT user_id, username, discord_id, roles_json, expires_at FROM sessions WHERE token_hash = ?',
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
    };
  }

  async putSession(record: SessionRecord): Promise<void> {
    this.database.prepare(`
      INSERT INTO sessions(token_hash, user_id, username, discord_id, roles_json, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(token_hash) DO UPDATE SET
        user_id=excluded.user_id, username=excluded.username,
        discord_id=excluded.discord_id, roles_json=excluded.roles_json,
        expires_at=excluded.expires_at
    `).run(tokenHash(record.token), record.userId, record.username, record.discordId ?? null, JSON.stringify(record.roles), record.expiresAt);
  }

  async revokeSession(token: string): Promise<void> {
    this.database.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash(token));
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
      discord_id TEXT, roles_json JSONB NOT NULL, expires_at BIGINT NOT NULL);
      CREATE TABLE IF NOT EXISTS module_kv (
        namespace TEXT NOT NULL, key TEXT NOT NULL, value_json JSONB NOT NULL,
        PRIMARY KEY(namespace, key))`);
  }
  async getSession(token: string): Promise<SessionRecord | null> {
    const result = await this.pool.query('SELECT * FROM sessions WHERE token_hash = $1 AND expires_at > $2', [tokenHash(token), Date.now()]);
    const row = result.rows[0];
    if (!row) return null;
    return { token, userId: row.user_id, username: row.username, discordId: row.discord_id ?? undefined, roles: row.roles_json, expiresAt: Number(row.expires_at) };
  }
  async putSession(record: SessionRecord): Promise<void> {
    await this.pool.query(`INSERT INTO sessions VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT(token_hash) DO UPDATE SET user_id=$2,username=$3,discord_id=$4,roles_json=$5,expires_at=$6`,
    [tokenHash(record.token), record.userId, record.username, record.discordId ?? null, JSON.stringify(record.roles), record.expiresAt]);
  }
  async revokeSession(token: string): Promise<void> { await this.pool.query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash(token)]); }
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
