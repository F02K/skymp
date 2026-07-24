import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { BackendConfig, Logger, Storage } from './types.js';
import type { RuntimeState } from './runtime-state.js';
import { GrantError, verifyDirectoryGrant } from './directory-auth.js';

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
}) {
  const { config, storage, state, logger, internalToken } = options;
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
  return { internalServer };
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
