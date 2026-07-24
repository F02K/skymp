import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureInternalToken, loadConfig, validateRuntimePaths } from './config.js';
import { createLogger } from './logger.js';
import { createStorage } from './storage.js';
import { RuntimeState } from './runtime-state.js';
import { ModuleLoader } from './module-loader.js';
import { startApis, stopServer } from './api.js';
import { Supervisor } from './supervisor.js';
import { ensureBackendConfig } from './setup.js';
import { ClientPackService } from './client-pack.js';

function configArgument(): string {
  const index = process.argv.indexOf('--config');
  return index >= 0 ? process.argv[index + 1] : 'backend.config.json';
}

async function main(): Promise<void> {
  const configPath = resolve(configArgument());
  const logger = createLogger(
    { component: 'core' },
    { filePath: resolve(dirname(configPath), 'logs', 'managed-server.jsonl') },
  );
  let storage: ReturnType<typeof createStorage> | undefined;
  let modules: ModuleLoader | undefined;
  let apis: Awaited<ReturnType<typeof startApis>> | undefined;
  let supervisor: Supervisor | undefined;
  let shuttingDown = false;

  const shutdown = async (reason: string, exitCode = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('Managed shutdown started', { reason });
    try {
      if (supervisor) await supervisor.stop();
      if (apis?.clientPackServer) await stopServer(apis.clientPackServer);
      if (apis) await stopServer(apis.internalServer);
      if (modules) await modules.stop();
      if (storage) await storage.close();
    } catch (cause) {
      logger.error('Managed shutdown failed', {
        cause: cause instanceof Error ? cause.message : String(cause),
      });
      exitCode = 1;
    }
    process.exitCode = exitCode;
  };

  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  try {
    await ensureBackendConfig(configPath, {
      force: process.argv.includes('--setup'),
    });
    const config = loadConfig(configPath);
    validateRuntimePaths(config);
    const internalToken = ensureInternalToken(config.server.internalTokenEnv);
    if (internalToken.generated) {
      logger.info('Generated an ephemeral internal backend token for this managed-server session', {
        environmentVariable: config.server.internalTokenEnv,
      });
    }
    storage = createStorage(config.database);
    const state = new RuntimeState(config.server.maxPlayers);
    const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    modules = new ModuleLoader(
      config,
      state,
      logger,
      resolve(packageRoot, 'modules.lock.json'),
      storage,
    );
    state.setState('starting');
    await storage.migrate();
    await modules.start();
    if (!config.server.id) throw new Error('Directory registration did not provide a server ID');
    supervisor = new Supervisor(config.supervisor, state, logger.child({ component: 'supervisor' }));
    await supervisor.prepare();
    const clientPack = modules.services.get('clientPack');
    if (config.server.clientPack && !(clientPack instanceof ClientPackService)) {
      throw new Error('Client Pack requires the directory-connector module');
    }
    apis = await startApis({
      config,
      storage,
      state,
      logger,
      internalToken: internalToken.value,
      ...(clientPack instanceof ClientPackService ? { clientPack } : {}),
    });
    const internalHost = config.internalApi.host.includes(':')
      ? `[${config.internalApi.host}]`
      : config.internalApi.host;
    await supervisor.start({
      SKYMP_BACKEND_URL: `http://${internalHost}:${config.internalApi.port}`,
      SKYMP_BACKEND_SERVER_ID: config.server.id,
      SKYMP_BACKEND_TOKEN_ENV: config.server.internalTokenEnv,
      SKYMP_SERVER_NAME: config.server.name,
      SKYMP_SERVER_MAX_PLAYERS: String(config.server.maxPlayers),
      SKYMP_SERVER_PORT: String(config.server.gamePort),
      SKYMP_GAMEMODE_PATH: config.server.gamemode,
      SKYMP_DATA_DIRECTORY: config.server.dataDirectory,
      SKYMP_LOAD_ORDER: JSON.stringify(config.server.loadOrder),
      ...(clientPack instanceof ClientPackService
        ? {
          SKYMP_CLIENT_PACK_VERSION: clientPack.manifest().version,
          SKYMP_CLIENT_PACK_MANIFEST_SHA256: clientPack.descriptor()!.manifestSha256,
        }
        : {}),
    });
  } catch (cause) {
    logger.error('Core startup failed; SkyMP will not start', { cause: cause instanceof Error ? cause.message : String(cause) });
    await shutdown('startup-failure', 1);
  }
}

void main().catch((cause) => {
  console.error(`Fatal managed-server failure: ${cause instanceof Error ? cause.stack ?? cause.message : String(cause)}`);
  process.exitCode = 1;
});
