import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
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

export function createLogger(
  base: Record<string, unknown> = {},
  options: { filePath?: string } = {},
): Logger {
  let fileLogging = Boolean(options.filePath);
  if (options.filePath) {
    try {
      mkdirSync(dirname(options.filePath), { recursive: true });
    } catch (cause) {
      fileLogging = false;
      console.error(`Unable to initialize managed-server log file: ${String(cause)}`);
    }
  }

  const writeLine = (level: string, line: string) => {
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
    if (fileLogging && options.filePath) {
      try {
        appendFileSync(options.filePath, `${line}\n`, 'utf8');
      } catch (cause) {
        fileLogging = false;
        console.error(`Unable to append to managed-server log file: ${String(cause)}`);
      }
  };
  };

  const build = (context: Record<string, unknown>): Logger => {
    const write = (level: string, message: string, fields: Record<string, unknown> = {}) => {
      const line = JSON.stringify(sanitize({
        timestamp: new Date().toISOString(),
        level,
        message,
        ...context,
        ...fields,
      }));
      writeLine(level, line);
    };
    return {
      debug: (message, fields) => write('debug', message, fields),
      info: (message, fields) => write('info', message, fields),
      warn: (message, fields) => write('warn', message, fields),
      error: (message, fields) => write('error', message, fields),
      child: (fields) => build({ ...context, ...fields }),
    };
  };

  return build(base);
}

export { sanitize };
