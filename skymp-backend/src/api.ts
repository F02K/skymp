import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { BackendConfig, Logger, Storage } from './types.js';
import type { RuntimeState } from './runtime-state.js';
import type { RouterRegistry } from './module-router.js';
import { GrantError, verifyDirectoryGrant } from './directory-auth.js';

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
  internalToken: string;
  routers: RouterRegistry;
  capabilities?: ReadonlySet<string>;
}) {
  const { config, storage, state, logger, internalToken, routers } = options;
  const enabled = options.capabilities ?? new Set<string>();
  const capabilityContract = () => ({
    authentication: 'directory-discord' as const,
    news: enabled.has('news'), mods: enabled.has('mods'), metrics: enabled.has('metrics'),
    clientDistribution: enabled.has('clientDistribution'), modpack: enabled.has('modpack'),
  });
  const publicServer = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/health/live') return json(res, 200, { status: 'ok' });
      if (req.method === 'GET' && url.pathname === '/health/ready') {
        const status = state.get();
        return json(res, status.state === 'online' ? 200 : 503, status);
      }
      const launcherServer = url.pathname.match(/^\/api\/launcher\/servers\/([^/]+)$/);
      if (req.method === 'GET' && launcherServer) {
        if (decodeURIComponent(launcherServer[1]) !== config.server.id) return error(res, 404, 'serverNotFound', 'Server was not found.');
        const [address, port] = splitGameAddress(config.server.gameAddress);
        const sessionToken = bearer(req);
        const validSession = sessionToken ? Boolean(await storage.getSession(sessionToken)) : false;
        return json(res, 200, {
          key: config.server.id, name: config.server.name, description: config.server.description,
          address, port, maxPlayers: state.get().maxPlayers, offlineMode: false,
          locked: false, capabilities: capabilityContract(),
          access: { sessionValid: validSession, allowed: validSession, reason: validSession ? null : 'directoryLoginRequired' },
        });
      }
      const launcherStatus = url.pathname.match(/^\/api\/launcher\/servers\/([^/]+)\/status$/);
      if (req.method === 'GET' && launcherStatus) {
        if (decodeURIComponent(launcherStatus[1]) !== config.server.id) return error(res, 404, 'serverNotFound', 'Server was not found.');
        return json(res, 200, state.get());
      }
      if (req.method === 'POST' && url.pathname === '/api/auth/directory/exchange') {
        const grant = verifyDirectoryGrant(await readBody(req), config);
        if (!await storage.consumeGrant(grant.jti, grant.expiresAt)) return error(res, 409, 'playGrantReplayed', 'Play grant was already redeemed.');
        const profileId = await storage.getOrCreateProfile(grant.identity.discordId, grant.identity.username);
        const token = randomBytes(32).toString('base64url'); const expiresAt = Date.now() + 12 * 60 * 60 * 1000;
        const roles = grant.membership?.roles ?? [];
        await storage.putSession({ token, userId: String(profileId), username: grant.identity.username, discordId: grant.identity.discordId, roles, expiresAt, profileId });
        return json(res, 201, { session: token, expiresAt, profileId, user: { profileId, discordId: grant.identity.discordId, username: grant.identity.username, roles } });
      }
      const launcherFeature = url.pathname.match(/^\/api\/launcher\/servers\/([^/]+)\/(.+)$/);
      if (req.method === 'GET' && launcherFeature) {
        if (decodeURIComponent(launcherFeature[1]) !== config.server.id) return error(res, 404, 'serverNotFound', 'Server was not found.');
        const capability = launcherCapability(launcherFeature[2]);
        if (!capability || !enabled.has(capability)) return error(res, 404, 'capabilityUnavailable', 'This server does not provide the requested capability.');
        const moduleResponse = await routers.dispatchLauncher(
          `/launcher/${launcherFeature[2]}`,
          { method: 'GET', path: url.pathname, headers: req.headers, body: {} },
        );
        if (!moduleResponse) return error(res, 503, 'capabilityUnavailable', 'The advertised capability has no active provider.');
        return json(res, moduleResponse.status ?? 200, moduleResponse.body ?? {}, moduleResponse.headers);
      }
      const moduleResponse = await routers.dispatch({ method: req.method ?? 'GET', path: url.pathname, headers: req.headers, body: ['POST', 'PUT', 'PATCH'].includes(req.method ?? '') ? await readBody(req) : {} });
      if (moduleResponse) return json(res, moduleResponse.status ?? 200, moduleResponse.body ?? {}, moduleResponse.headers);
      return error(res, 404, 'notFound', 'Route not found.');
    } catch (cause) {
      logger.error('Public API request failed', { cause: cause instanceof Error ? cause.message : String(cause) });
      if (cause instanceof GrantError) return error(res, cause.status, cause.code, cause.message);
      return error(res, 400, 'invalidRequest', 'The request could not be processed.');
    }
  });

  const internalServer = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/health/live') return json(res, 200, { status: 'ok' });
      const heartbeat = url.pathname.match(/^\/api\/internal\/servers\/([^/]+)\/heartbeat$/);
      if (req.method === 'POST' && heartbeat) {
        if (decodeURIComponent(heartbeat[1]) !== config.server.id) return error(res, 404, 'serverNotFound', 'Server was not found.');
        if (!secureEqual(bearer(req), internalToken)) return error(res, 403, 'invalidServerToken', 'Invalid server authorization token.');
        const body = await readBody(req) as Record<string, unknown>;
        const online = Number(body.online ?? 0);
        const maxPlayers = Number(body.maxPlayers ?? config.server.maxPlayers);
        if (!Number.isInteger(online) || !Number.isInteger(maxPlayers) || online < 0 || maxPlayers < 1) return error(res, 400, 'invalidHeartbeat', 'Invalid heartbeat.');
        state.heartbeat(online, maxPlayers);
        return json(res, 200, state.get());
      }
      const session = url.pathname.match(/^\/api\/internal\/servers\/([^/]+)\/sessions\/([^/]+)$/);
      if (req.method === 'GET' && session) {
        if (decodeURIComponent(session[1]) !== config.server.id) return error(res, 404, 'serverNotFound', 'Server was not found.');
        if (!secureEqual(bearer(req), internalToken)) return error(res, 403, 'invalidServerToken', 'Invalid server authorization token.');
        const record = await storage.getSession(decodeURIComponent(session[2]));
        if (!record) return error(res, 404, 'sessionNotFound', 'Session was not found or has expired.');
        return json(res, 200, { user: { id: record.profileId, discordId: record.discordId, username: record.username, roles: record.roles } });
      }
      return error(res, 404, 'notFound', 'Route not found.');
    } catch (cause) {
      logger.error('Internal API request failed', { cause: cause instanceof Error ? cause.message : String(cause) });
      return error(res, 400, 'invalidRequest', 'The request could not be processed.');
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

function launcherCapability(pathname: string): string | null {
  if (pathname === 'news') return 'news';
  if (pathname === 'mods') return 'mods';
  if (pathname === 'metrics') return 'metrics';
  if (pathname === 'client/manifest' || pathname === 'client/download') return 'clientDistribution';
  if (pathname === 'modpack/manifest' || pathname === 'modpack/download') return 'modpack';
  return null;
}

export async function stopServer(server: import('node:http').Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((cause) => cause ? reject(cause) : resolve()));
}
