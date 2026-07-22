import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { BackendConfig, Logger, Storage } from './types.js';
import type { RuntimeState } from './runtime-state.js';
import type { RouterRegistry } from './module-router.js';

const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
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
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
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
  masterKey: string;
  issuerToken: string;
  routers: RouterRegistry;
}) {
  const { config, storage, state, logger, masterKey, issuerToken, routers } = options;
  const publicServer = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/health/live') return json(res, 200, { status: 'ok' });
      if (req.method === 'GET' && url.pathname === '/health/ready') {
        const status = state.get();
        return json(res, status.state === 'online' ? 200 : 503, status);
      }
      if (req.method === 'GET' && url.pathname === '/api/v2/server') {
        const status = state.get();
        return json(res, 200, { ...config.server, status: status.state, online: status.online, maxPlayers: status.maxPlayers });
      }
      if (req.method === 'GET' && url.pathname === '/api/v2/launcher/servers') {
        const [address, port] = splitGameAddress(config.server.gameAddress);
        return json(res, 200, { items: [{ key: config.server.id, name: config.server.name, address, port, backendUrl: config.server.publicBackendUrl }], total: 1 });
      }
      const launcherServer = url.pathname.match(/^\/api\/v2\/launcher\/servers\/([^/]+)$/);
      if (req.method === 'GET' && launcherServer) {
        if (decodeURIComponent(launcherServer[1]) !== config.server.id && decodeURIComponent(launcherServer[1]) !== 'default') return error(res, 404, 'serverNotFound', 'Server was not found.');
        const [address, port] = splitGameAddress(config.server.gameAddress);
        const sessionToken = String(req.headers['x-session'] ?? '');
        const validSession = sessionToken ? Boolean(await storage.getSession(sessionToken)) : false;
        return json(res, 200, { key: config.server.id, name: config.server.name, address, port, maxPlayers: state.get().maxPlayers, offlineMode: false, masterKey, masterUrl: config.server.publicBackendUrl, locked: false, sessionValid: validSession, allowed: validSession });
      }
      const launcherStatus = url.pathname.match(/^\/api\/v2\/launcher\/servers\/([^/]+)\/status$/);
      if (req.method === 'GET' && launcherStatus) return json(res, 200, state.get());
      if (req.method === 'POST' && url.pathname === '/api/v2/auth/sessions') {
        if (!secureEqual(bearer(req), issuerToken)) return error(res, 403, 'invalidIssuerToken', 'Invalid session issuer token.');
        const body = await readBody(req) as Record<string, unknown>;
        if (!body.userId || !body.username) return error(res, 400, 'invalidSession', 'userId and username are required.');
        const token = randomBytes(32).toString('base64url');
        const expiresAt = Date.now() + config.sessions.ttlSeconds * 1000;
        await storage.putSession({ token, userId: String(body.userId), username: String(body.username), discordId: body.discordId ? String(body.discordId) : undefined, roles: Array.isArray(body.roles) ? body.roles.map(String) : [], expiresAt });
        return json(res, 201, { token, expiresAt });
      }
      if (req.method === 'DELETE' && url.pathname.startsWith('/api/v2/auth/sessions/')) {
        if (!secureEqual(bearer(req), issuerToken)) return error(res, 403, 'invalidIssuerToken', 'Invalid session issuer token.');
        await storage.revokeSession(decodeURIComponent(url.pathname.slice('/api/v2/auth/sessions/'.length)));
        return json(res, 204, null);
      }
      const moduleResponse = await routers.dispatch({ method: req.method ?? 'GET', path: url.pathname, headers: req.headers, body: ['POST', 'PUT', 'PATCH'].includes(req.method ?? '') ? await readBody(req) : {} });
      if (moduleResponse) return json(res, moduleResponse.status ?? 200, moduleResponse.body ?? {}, moduleResponse.headers);
      return error(res, 404, 'notFound', 'Route not found.');
    } catch (cause) {
      logger.error('Public API request failed', { cause: cause instanceof Error ? cause.message : String(cause) });
      return error(res, 400, 'invalidRequest', 'The request could not be processed.');
    }
  });

  const internalServer = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/health/live') return json(res, 200, { status: 'ok' });
      const heartbeat = url.pathname.match(/^\/api\/servers\/([^/]+)$/);
      if (req.method === 'POST' && heartbeat) {
        if (!secureEqual(decodeURIComponent(heartbeat[1]), masterKey)) return json(res, 403, { error: 'Invalid master key.' });
        const body = await readBody(req) as Record<string, unknown>;
        const online = Number(body.online ?? 0);
        const maxPlayers = Number(body.maxPlayers ?? config.server.maxPlayers);
        if (!Number.isInteger(online) || !Number.isInteger(maxPlayers) || online < 0 || maxPlayers < 1) return json(res, 400, { error: 'Invalid heartbeat.' });
        state.heartbeat(online, maxPlayers);
        return json(res, 200, { ok: true });
      }
      const session = url.pathname.match(/^\/api\/servers\/([^/]+)\/sessions\/([^/]+)$/);
      if (req.method === 'GET' && session) {
        if (!secureEqual(decodeURIComponent(session[1]), masterKey)) return json(res, 403, { error: 'Invalid master key.' });
        const record = await storage.getSession(decodeURIComponent(session[2]));
        if (!record) return json(res, 404, { error: 'sessionNotFound' });
        return json(res, 200, { user: { id: record.userId, discordId: record.discordId, username: record.username, roles: record.roles } });
      }
      return json(res, 404, { error: 'Not found.' });
    } catch (cause) {
      logger.error('Internal API request failed', { cause: cause instanceof Error ? cause.message : String(cause) });
      return json(res, 400, { error: 'Invalid request.' });
    }
  });

  await Promise.all([
    new Promise<void>((resolve, reject) => publicServer.listen(config.publicApi.port, config.publicApi.host, resolve).once('error', reject)),
    new Promise<void>((resolve, reject) => internalServer.listen(config.internalApi.port, config.internalApi.host, resolve).once('error', reject)),
  ]);
  logger.info('API listeners started', { publicApi: config.publicApi, internalApi: config.internalApi });
  return { publicServer, internalServer };
}

function splitGameAddress(value: string): [string, number] {
  const ipv6 = value.match(/^\[([^\]]+)]:(\d+)$/);
  if (ipv6) return [ipv6[1], Number(ipv6[2])];
  const separator = value.lastIndexOf(':');
  if (separator < 1) throw new Error('server.gameAddress must contain host:port');
  return [value.slice(0, separator), Number(value.slice(separator + 1))];
}

export async function stopServer(server: import('node:http').Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((cause) => cause ? reject(cause) : resolve()));
}
