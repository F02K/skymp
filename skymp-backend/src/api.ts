import { timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { BackendConfig, Logger, Storage } from './types.js';
import type { RuntimeState } from './runtime-state.js';
import { GrantError, verifyDirectoryGrant } from './directory-auth.js';
import type { ClientPackService } from './client-pack.js';

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
};

const error = (res: ServerResponse, status: number, code: string, message: string) =>
  json(res, status, { error: { code, message } });

async function readBody(req: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > 1024 * 1024) throw new Error('requestBodyTooLarge');
    chunks.push(buffer);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

function secureEqual(actual: string, expected: string): boolean {
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function bearer(req: IncomingMessage): string {
  const header = req.headers.authorization ?? '';
  return header.startsWith('Bearer ') ? header.slice(7) : '';
}

export async function startApis(options: {
  config: BackendConfig;
  storage: Storage;
  state: RuntimeState;
  logger: Logger;
  internalToken: string;
  clientPack?: ClientPackService;
}) {
  const { config, storage, state, logger, internalToken, clientPack } = options;
  const internalServer = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/health/live') {
        return json(res, 200, { status: 'ok' });
      }
      if (!secureEqual(bearer(req), internalToken)) {
        return error(res, 403, 'invalidServerToken', 'Invalid server authorization token.');
      }
      const heartbeat = url.pathname.match(/^\/api\/internal\/servers\/([^/]+)\/heartbeat$/);
      if (req.method === 'POST' && heartbeat) {
        if (!matchesServer(config, heartbeat[1])) return error(res, 404, 'serverNotFound', 'Server was not found.');
        const body = await readBody(req) as Record<string, unknown>;
        const online = Number(body.online ?? 0);
        const maxPlayers = Number(body.maxPlayers ?? config.server.maxPlayers);
        if (!Number.isInteger(online) || !Number.isInteger(maxPlayers) || online < 0 || maxPlayers < 1) {
          return error(res, 400, 'invalidHeartbeat', 'Invalid heartbeat.');
        }
        state.heartbeat(online, maxPlayers);
        return json(res, 200, state.get());
      }
      const validate = url.pathname.match(/^\/api\/internal\/servers\/([^/]+)\/sessions\/validate$/);
      if (req.method === 'POST' && validate) {
        if (!matchesServer(config, validate[1])) return error(res, 404, 'serverNotFound', 'Server was not found.');
        const body = await readBody(req) as Record<string, unknown>;
        const ticket = typeof body.ticket === 'string' ? body.ticket : '';
        const reconnect = ticket ? await storage.getSession(ticket) : null;
        if (reconnect) return json(res, 200, sessionResponse(reconnect));

        const grant = verifyDirectoryGrant({ ticket }, config);
        if (!await storage.consumeGrant(grant.jti, grant.expiresAt)) {
          const raced = await storage.getSession(ticket);
          if (raced) return json(res, 200, sessionResponse(raced));
          return error(res, 409, 'playTicketReplayed', 'Play ticket was already redeemed.');
        }
        const profileId = await storage.getOrCreateProfile(grant.identity.discordId, grant.identity.username);
        const record = {
          token: ticket,
          userId: String(profileId),
          username: grant.identity.username,
          discordId: grant.identity.discordId,
          roles: grant.membership?.roles ?? [],
          expiresAt: Date.now() + config.sessions.ttlSeconds * 1000,
          profileId,
        };
        await storage.putSession(record);
        return json(res, 201, sessionResponse(record));
      }
      return error(res, 404, 'notFound', 'Route not found.');
    } catch (cause) {
      logger.error('Internal API request failed', { cause: cause instanceof Error ? cause.message : String(cause) });
      if (cause instanceof GrantError) return error(res, cause.status, cause.code, cause.message);
      return error(res, 400, 'invalidRequest', 'The request could not be processed.');
    }
  });

  await new Promise<void>((resolve, reject) =>
    internalServer.listen(config.internalApi.port, config.internalApi.host, resolve).once('error', reject));
  logger.info('Loopback managed backend listener started', { internalApi: config.internalApi });

  let clientPackServer: import('node:http').Server | undefined;
  if (clientPack) {
    const listener = clientPack.config;
    clientPackServer = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/api/client-pack/manifest') {
        const body = clientPack.manifestBytes();
        const etag = `"${clientPack.descriptor()!.manifestSha256}"`;
        if (req.headers['if-none-match'] === etag) {
          res.writeHead(304, { etag, 'cache-control': 'public, max-age=60, immutable' });
          return res.end();
        }
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'content-length': String(body.length),
          etag,
          'cache-control': 'public, max-age=60, immutable',
          'x-content-type-options': 'nosniff',
        });
        return res.end(body);
      }
      if ((req.method === 'GET' || req.method === 'HEAD')
        && url.pathname === '/api/client-pack/archive') {
        return serveClientPackArchive(req, res, clientPack);
      }
      return error(res, 404, 'notFound', 'Route not found.');
    });
    try {
      await new Promise<void>((resolve, reject) =>
        clientPackServer!.listen(listener.port, listener.host, resolve).once('error', reject));
    } catch (cause) {
      await stopServer(internalServer);
      throw cause;
    }
    logger.info('Public Client Pack listener started', {
      host: listener.host,
      port: listener.port,
      manifestSha256: clientPack.descriptor()?.manifestSha256,
    });
  }
  return { internalServer, clientPackServer };
}

function serveClientPackArchive(
  req: IncomingMessage,
  res: ServerResponse,
  clientPack: ClientPackService,
): void {
  const size = clientPack.archiveSize;
  const etag = `"${clientPack.archiveSha256}"`;
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { etag, 'cache-control': 'public, max-age=31536000, immutable' });
    res.end();
    return;
  }
  const range = req.headers.range;
  let start = 0;
  let end = size - 1;
  let status = 200;
  if (range !== undefined) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match || (!match[1] && !match[2])) {
      res.writeHead(416, { 'content-range': `bytes */${size}` });
      res.end();
      return;
    }
    if (!match[1]) {
      const suffix = Number(match[2]);
      if (!Number.isSafeInteger(suffix) || suffix < 1) {
        res.writeHead(416, { 'content-range': `bytes */${size}` });
        res.end();
        return;
      }
      start = Math.max(0, size - suffix);
    } else {
      start = Number(match[1]);
      end = match[2] ? Number(match[2]) : end;
    }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)
      || start < 0 || start >= size || end < start) {
      res.writeHead(416, { 'content-range': `bytes */${size}` });
      res.end();
      return;
    }
    end = Math.min(end, size - 1);
    status = 206;
  }
  const headers: Record<string, string> = {
    'content-type': 'application/zip',
    'content-length': String(end - start + 1),
    'accept-ranges': 'bytes',
    etag,
    'cache-control': 'public, max-age=31536000, immutable',
    'x-content-type-options': 'nosniff',
  };
  if (status === 206) headers['content-range'] = `bytes ${start}-${end}/${size}`;
  res.writeHead(status, headers);
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  const stream = createReadStream(clientPack.archivePath, { start, end });
  stream.once('error', () => res.destroy());
  stream.pipe(res);
}

function matchesServer(config: BackendConfig, encodedId: string): boolean {
  return Boolean(config.server.id) && decodeURIComponent(encodedId) === config.server.id;
}

function sessionResponse(record: {
  profileId: number; discordId?: string; username: string; roles: string[]; expiresAt: number;
}) {
  return {
    expiresAt: record.expiresAt,
    user: {
      id: record.profileId,
      discordId: record.discordId,
      username: record.username,
      roles: record.roles,
    },
  };
}

export async function stopServer(server: import('node:http').Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((cause) => cause ? reject(cause) : resolve()));
}
