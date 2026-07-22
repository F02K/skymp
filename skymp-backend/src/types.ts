import type { EventEmitter } from 'node:events';
import type { Server } from 'node:http';

export type ServerState =
  | 'starting'
  | 'online'
  | 'maintenance'
  | 'draining'
  | 'crashed'
  | 'restart-backoff'
  | 'offline';

export interface ListenerConfig { host: string; port: number }

export interface BackendConfig {
  publicApi: ListenerConfig;
  internalApi: ListenerConfig;
  database: {
    adapter: 'sqlite' | 'postgres';
    path?: string;
    connectionStringEnv?: string;
  };
  server: {
    id: string;
    masterKeyEnv: string;
    name: string;
    description: string;
    region: string;
    tags: string[];
    publicBackendUrl: string;
    gameAddress: string;
    maxPlayers: number;
    visibility: 'public' | 'private';
    versions?: Record<string, string>;
  };
  supervisor: {
    command: string;
    args: string[];
    cwd: string;
    readyTimeoutMs: number;
    shutdownTimeoutMs: number;
    restart: {
      enabled: boolean;
      initialDelayMs: number;
      maxDelayMs: number;
      maxAttempts: number;
      windowMs: number;
    };
  };
  sessions: { issuerTokenEnv: string; ttlSeconds: number };
  modules: ModuleSelection[];
}

export interface ModuleSelection {
  id: string;
  enabled: boolean;
  required: boolean;
  path?: string;
  config?: Record<string, unknown>;
}

export interface ModuleManifest {
  id: string;
  version: string;
  coreApiVersion: string;
  dependencies: string[];
  entryPoint: string;
  configSchema?: Record<string, unknown>;
}

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

export interface Storage {
  migrate(): Promise<void>;
  getSession(token: string): Promise<SessionRecord | null>;
  putSession(record: SessionRecord): Promise<void>;
  revokeSession(token: string): Promise<void>;
  getModuleValue(namespace: string, key: string): Promise<unknown>;
  putModuleValue(namespace: string, key: string, value: unknown): Promise<void>;
  deleteModuleValue(namespace: string, key: string): Promise<void>;
  close(): Promise<void>;
}

export interface SessionRecord {
  token: string;
  userId: string;
  username: string;
  discordId?: string;
  roles: string[];
  expiresAt: number;
}

export interface RuntimeStatus {
  state: ServerState;
  online: number;
  maxPlayers: number;
  childPid?: number;
  lastHeartbeatAt?: number;
  startedAt: number;
}

export interface ModuleContext {
  config: Readonly<Record<string, unknown>>;
  logger: Logger;
  events: EventEmitter;
  getStatus(): RuntimeStatus;
  getSecret(name: string): string | undefined;
  services: Map<string, unknown>;
  router: ModuleRouter;
  database: ModuleDatabase;
}

export interface ModuleDatabase {
  get<T = unknown>(key: string): Promise<T | null>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  migrate(version: number, migration: (database: ModuleDatabase) => Promise<void>): Promise<void>;
}

export interface ModuleRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

export interface ModuleResponse {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface ModuleRouter {
  add(method: string, path: string, handler: (request: ModuleRequest) => Promise<ModuleResponse> | ModuleResponse): void;
}

export interface BackendModule {
  manifest: ModuleManifest;
  start(context: ModuleContext): Promise<void> | void;
  stop(): Promise<void> | void;
}

export interface ApiHandles { publicServer: Server; internalServer: Server }
