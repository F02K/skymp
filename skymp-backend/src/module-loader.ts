import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { BackendConfig, BackendModule, Logger, ModuleContext, ModuleDatabase, ModuleManifest, Storage } from './types.js';
import type { RuntimeState } from './runtime-state.js';
import { RouterRegistry } from './module-router.js';
import { DirectoryConnector } from './modules/directory-connector.js';

interface LockFile { coreApiVersion: string; modules: Record<string, string> }

export class ModuleLoader {
  readonly routers = new RouterRegistry();
  readonly services = new Map<string, unknown>();
  private readonly started: BackendModule[] = [];

  constructor(
    private readonly config: BackendConfig,
    private readonly state: RuntimeState,
    private readonly logger: Logger,
    private readonly lockFilePath: string,
    private readonly storage: Storage,
  ) {}

  async start(): Promise<void> {
    const lock = JSON.parse(readFileSync(this.lockFilePath, 'utf8')) as LockFile;
    const selected = this.config.modules.filter((item) => item.enabled);
    const loaded = new Map<string, { module: BackendModule; required: boolean; config: Record<string, unknown> }>();
    for (const item of selected) {
      try {
        const module = await this.load(item.id, item.path);
        this.validateManifest(module.manifest, lock);
        loaded.set(item.id, { module, required: item.required, config: item.config ?? {} });
      } catch (cause) {
        if (item.required) throw new Error(`Required module ${item.id} could not be loaded`, { cause });
        this.logger.warn('Optional module could not be loaded', { moduleId: item.id, cause: cause instanceof Error ? cause.message : String(cause) });
      }
    }

    const ordered = this.sort(loaded);
    for (const entry of ordered) {
      const database = this.moduleDatabase(entry.module.manifest.id);
      this.validateModuleConfig(entry.module.manifest, entry.config);
      const context: ModuleContext = {
        config: Object.freeze(structuredClone(entry.config)),
        logger: this.logger.child({ moduleId: entry.module.manifest.id }),
        events: this.state,
        getStatus: () => this.state.get(),
        getSecret: (name) => process.env[name],
        services: this.services,
        router: this.routers.create(entry.module.manifest.id),
        database,
      };
      try {
        await entry.module.start(context);
        this.started.push(entry.module);
        this.logger.info('Module started', { moduleId: entry.module.manifest.id, version: entry.module.manifest.version });
      } catch (cause) {
        if (entry.required) throw new Error(`Required module ${entry.module.manifest.id} failed to start`, { cause });
        this.logger.warn('Optional module failed to start', { moduleId: entry.module.manifest.id, cause: cause instanceof Error ? cause.message : String(cause) });
      }
    }
  }

  private moduleDatabase(namespace: string): ModuleDatabase {
    const database: ModuleDatabase = {
      get: <T>(key: string) => this.storage.getModuleValue(namespace, key) as Promise<T | null>,
      set: (key, value) => this.storage.putModuleValue(namespace, key, value),
      delete: (key) => this.storage.deleteModuleValue(namespace, key),
      migrate: async (version, migration) => {
        if (!Number.isInteger(version) || version < 1) throw new Error('Module migration version must be a positive integer');
        const current = Number(await database.get<number>('__migration_version') ?? 0);
        if (version <= current) return;
        if (version !== current + 1) throw new Error(`Module ${namespace} migration ${version} is not consecutive after ${current}`);
        await migration(database);
        await database.set('__migration_version', version);
      },
    };
    return database;
  }

  private async load(id: string, path?: string): Promise<BackendModule> {
    if (id === 'directory-connector' && !path) return new DirectoryConnector(this.config.server);
    if (!path) throw new Error(`No builtin module or path exists for ${id}`);
    const root = resolve(path);
    const manifest = JSON.parse(readFileSync(resolve(root, 'skymp-module.json'), 'utf8')) as ModuleManifest;
    if (manifest.id !== id) throw new Error(`Manifest ID ${manifest.id} does not match ${id}`);
    const entryPath = resolve(root, manifest.entryPoint);
    if (!entryPath.startsWith(`${root}/`) && !entryPath.startsWith(`${root}\\`)) throw new Error('Module entry point escapes its module directory');
    const imported = await import(pathToFileURL(entryPath).href);
    const instance = imported.default as BackendModule;
    if (!instance || typeof instance.start !== 'function' || typeof instance.stop !== 'function') throw new Error('Module must export a default BackendModule instance');
    instance.manifest = manifest;
    return instance;
  }

  private validateManifest(manifest: ModuleManifest, lock: LockFile): void {
    if (manifest.coreApiVersion !== lock.coreApiVersion) throw new Error(`Module ${manifest.id} requires core API ${manifest.coreApiVersion}; core provides ${lock.coreApiVersion}`);
    if (lock.modules[manifest.id] !== manifest.version) throw new Error(`Module ${manifest.id}@${manifest.version} is not pinned in modules.lock.json`);
  }

  private validateModuleConfig(manifest: ModuleManifest, config: Record<string, unknown>): void {
    const schema = manifest.configSchema as { required?: string[]; properties?: Record<string, { type?: string }> } | undefined;
    if (!schema) return;
    for (const name of schema.required ?? []) {
      if (config[name] === undefined || config[name] === '') throw new Error(`Module ${manifest.id} config requires ${name}`);
    }
    for (const [name, rule] of Object.entries(schema.properties ?? {})) {
      if (config[name] !== undefined && rule.type && typeof config[name] !== rule.type) throw new Error(`Module ${manifest.id} config ${name} must be ${rule.type}`);
    }
  }

  private sort(entries: Map<string, { module: BackendModule; required: boolean; config: Record<string, unknown> }>) {
    const result: Array<{ module: BackendModule; required: boolean; config: Record<string, unknown> }> = [];
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (id: string) => {
      if (visited.has(id)) return;
      if (visiting.has(id)) throw new Error(`Module dependency cycle contains ${id}`);
      const entry = entries.get(id);
      if (!entry) throw new Error(`Enabled module dependency ${id} is missing`);
      visiting.add(id);
      for (const dependency of entry.module.manifest.dependencies) visit(dependency);
      visiting.delete(id);
      visited.add(id);
      result.push(entry);
    };
    for (const id of entries.keys()) visit(id);
    return result;
  }

  async stop(): Promise<void> {
    for (const module of [...this.started].reverse()) {
      try { await module.stop(); }
      catch (cause) { this.logger.error('Module stop failed', { moduleId: module.manifest.id, cause: String(cause) }); }
    }
    this.started.length = 0;
  }
}
