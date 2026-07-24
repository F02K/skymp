import type { Logger } from './types.js';

const secretKey = /token|secret|credential|password|masterkey|privatekey|authorization/i;

function sanitize(value: unknown, key = ''): unknown {
  if (secretKey.test(key)) return '[REDACTED]';
  if (Array.isArray(value)) return value.map((item) => sanitize(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [entryKey, sanitize(entryValue, entryKey)]),
    );
  }
  return value;
}

export function createLogger(base: Record<string, unknown> = {}): Logger {
  const write = (level: string, message: string, fields: Record<string, unknown> = {}) => {
    const line = JSON.stringify(sanitize({ timestamp: new Date().toISOString(), level, message, ...base, ...fields }));
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  };
  return {
    debug: (message, fields) => write('debug', message, fields),
    info: (message, fields) => write('info', message, fields),
    warn: (message, fields) => write('warn', message, fields),
    error: (message, fields) => write('error', message, fields),
    child: (fields) => createLogger({ ...base, ...fields }),
  };
}

export { sanitize };
