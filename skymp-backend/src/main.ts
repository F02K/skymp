import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, requireSecret } from './config.js';
import { createLogger } from './logger.js';
import { createStorage } from './storage.js';
import { RuntimeState } from './runtime-state.js';
import { ModuleLoader } from './module-loader.js';
import { startApis, stopServer } from './api.js';
import { Supervisor } from './supervisor.js';

function configArgument(): string {
  const index = process.argv.indexOf('--config');
  return index >= 0 ? process.argv[index + 1] : 'backend.config.json';
}

async function main(): Promise<void> {
  const logger = createLogger({ component: 'core' });
  const config = loadConfig(configArgument());
  const internalToken = requireSecret(config.server.internalTokenEnv);
  const storage = createStorage(config.database);
  const state = new RuntimeState(config.server.maxPlayers);
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const modules = new ModuleLoader(config, state, logger, resolve(packageRoot, 'modules.lock.json'), storage);
  let apis: Awaited<ReturnType<typeof startApis>> | undefined;
  let supervisor: Supervisor | undefined;
  let shuttingDown = false;

  const shutdown = async (reason: string, exitCode = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('Managed shutdown started', { reason });
    try {
      if (supervisor) await supervisor.stop();
      await modules.stop();
      if (apis) await Promise.all([stopServer(apis.publicServer), stopServer(apis.internalServer)]);
      await storage.close();
    } catch (cause) {
      logger.error('Managed shutdown failed', { cause: cause instanceof Error ? cause.message : String(cause) });
      exitCode = 1;
    }
    process.exitCode = exitCode;
  };

  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  try {
    state.setState('starting');
    await storage.migrate();
    await modules.start();
    apis = await startApis({ config, storage, state, logger, internalToken, routers: modules.routers, capabilities: modules.capabilities });
    supervisor = new Supervisor(config.supervisor, state, logger.child({ component: 'supervisor' }));
    await supervisor.start();
  } catch (cause) {
    logger.error('Core startup failed; SkyMP will not start', { cause: cause instanceof Error ? cause.message : String(cause) });
    await shutdown('startup-failure', 1);
  }
}

void main();
