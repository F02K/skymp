import { ensureBackendConfig } from './setup.js';

function configArgument(): string {
  const index = process.argv.indexOf('--config');
  return index >= 0 ? process.argv[index + 1] : 'backend.config.json';
}

await ensureBackendConfig(configArgument(), { force: true });
