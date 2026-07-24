import { randomBytes } from 'node:crypto';
import type { BackendConfig, BackendModule, ModuleContext } from '../types.js';
import {
  canonicalDirectoryRequest,
  createDirectoryIdentity,
  signWithDirectoryIdentity,
  type StoredDirectoryIdentity,
  validateStoredDirectoryIdentity,
} from '../directory-protocol.js';

interface DirectoryConfig {
  url?: string;
  autoRegister?: boolean;
  heartbeatIntervalMs?: number;
}

interface RegistrationResponse {
  schemaVersion: 1;
  serverId: string;
  identityFingerprint: string;
  directorySigningKey: { algorithm: 'Ed25519'; publicKey: string };
  registrationStatus: 'created' | 'existing' | 'updated' | 'migrated' | 'recovered';
  registeredAt: number;
  joinCode?: string;
}

interface DirectoryErrorBody {
  error?: { code?: string; message?: string; retryAt?: number; retryAfter?: number; reason?: string; verificationUrl?: string };
}


export class DirectoryConnector implements BackendModule {
  readonly manifest = {
    id: 'directory-connector', version: '0.2.0', coreContract: 'managed-backend' as const, dependencies: [], entryPoint: 'builtin',
    configSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        autoRegister: { type: 'boolean' },
        heartbeatIntervalMs: { type: 'number' },
      },
    },
  };
  private timer?: NodeJS.Timeout;
  private registrationTimer?: NodeJS.Timeout;
  private context?: ModuleContext;
  private statusListener?: () => void;
  private identity?: StoredDirectoryIdentity;
  private stopping = false;

  constructor(private readonly backend: BackendConfig) {}

  async start(context: ModuleContext): Promise<void> {
    this.context = context;
    this.stopping = false;
    const config = this.connectorConfig();
    const stored = await context.database.get<StoredDirectoryIdentity>('identity');
    if (stored && !validateStoredDirectoryIdentity(stored)) {
      throw new Error('Stored Directory identity is corrupt; restore the backend database or remove only the directory-connector identity after the old server is offline');
    }
    this.identity = stored ?? createDirectoryIdentity();
    if (!stored) {
      await this.persistIdentity();
      context.logger.info('Generated persistent Directory server identity', {
        storage: 'backend database',
      });
    }
    this.applyStoredRegistration();
    if (config.autoRegister !== false) {
      if (this.identity.serverId && this.identity.directoryPublicKey) {
        await this.registerOnce().catch((cause) => {
          context.logger.warn('Directory metadata refresh failed; starting with the stored registration and retrying in the background', {
            cause: errorMessage(cause),
          });
          this.scheduleRegistrationRetry();
        });
      } else {
        await this.registerWithRetry();
      }
    } else if (!this.backend.server.id) {
      throw new Error('server.id is required when directory autoRegister is disabled');
    }

    await this.send().catch((cause) => context.logger.warn('Initial directory heartbeat failed; continuing fail-open', { cause: errorMessage(cause) }));
    this.timer = setInterval(
      () => void this.send().catch((cause) => context.logger.warn('Directory heartbeat failed', { cause: errorMessage(cause) })),
      config.heartbeatIntervalMs ?? 15000,
    );
    this.statusListener = () => void this.send().catch((cause) =>
      context.logger.warn('Directory status update failed', { cause: errorMessage(cause) }));
    context.events.on('status', this.statusListener);
  }

  private async registerWithRetry(): Promise<void> {
    let delay = 1000;
    let transientAttempts = 0;
    for (let attempt = 1; !this.stopping; ++attempt) {
      try {
        await this.registerOnce();
        return;
      } catch (cause) {
        const error = cause as DirectoryRegistrationError;
        if (error.permanent) throw error;
        if (!error.retryAt && ++transientAttempts > 6) break;
        const wait = error.retryAt
          ? Math.max(1000, Math.min(error.retryAt - Date.now(), 60_000))
          : delay;
        this.context?.logger.warn('Directory registration will be retried automatically', {
          attempt,
          retryInMs: wait,
          cause: errorMessage(cause),
        });
        await new Promise((resolve) => setTimeout(resolve, wait));
        delay = Math.min(delay * 2, 30_000);
      }
    }
    throw new Error('Directory registration did not succeed after automatic retries; check DNS, HTTPS certificate and outbound connectivity');
  }

  private async registerOnce(): Promise<void> {
    const context = this.requireContext();
    const identity = this.requireIdentity();
    const descriptor = this.descriptor();
    const path = '/api/server-registrations';
    const rawBody = JSON.stringify({
      schemaVersion: 1,
      publicKey: identity.publicKey,
      descriptor,
      ...(this.backend.server.id || identity.serverId
        ? { requestedServerId: this.backend.server.id || identity.serverId }
        : {}),
    });
    const timestamp = String(Date.now());
    const nonce = randomBytes(18).toString('base64url');
    const signature = signWithDirectoryIdentity(
      identity,
      canonicalDirectoryRequest('register', 'POST', path, timestamp, nonce, rawBody),
    );
    let response: Response;
    try {
      response = await fetch(`${this.directoryUrl()}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-skymp-timestamp': timestamp,
          'x-skymp-nonce': nonce,
          'x-skymp-signature': signature,
        },
        body: rawBody,
        signal: AbortSignal.timeout(10_000),
      });
    } catch (cause) {
      throw new DirectoryRegistrationError(`Directory is unreachable: ${errorMessage(cause)}`);
    }
    const payload = await response.json().catch(() => ({})) as RegistrationResponse & DirectoryErrorBody;
    if (!response.ok) {
      const code = payload.error?.code ?? `http${response.status}`;
      const reason = payload.error?.reason ? ` ${payload.error.reason}` : '';
      throw new DirectoryRegistrationError(
        `${payload.error?.message ?? `Directory returned HTTP ${response.status}`}${reason}`,
        payload.error?.retryAt ?? payload.error?.retryAfter,
        response.status >= 400 && response.status < 500
          && code !== 'registrationRecoveryPending'
          && code !== 'rateLimited',
      );
    }
    if (payload.schemaVersion !== 1 || !payload.serverId
      || payload.directorySigningKey?.algorithm !== 'Ed25519'
      || !payload.directorySigningKey.publicKey) {
      throw new DirectoryRegistrationError('Directory returned a malformed registration response', undefined, true);
    }
    const pinned = this.backend.sessions.directoryPublicKey ?? identity.directoryPublicKey;
    if (pinned && pinned !== payload.directorySigningKey.publicKey) {
      throw new DirectoryRegistrationError(
        'Directory signing key changed; refusing to trust the new key automatically',
        undefined,
        true,
      );
    }
    identity.serverId = payload.serverId;
    identity.directoryPublicKey = payload.directorySigningKey.publicKey;
    identity.joinCode = payload.joinCode;
    this.backend.server.id = payload.serverId;
    this.backend.sessions.directoryPublicKey = payload.directorySigningKey.publicKey;
    await this.persistIdentity();
    context.logger.info('Directory registration is ready', {
      serverId: payload.serverId,
      status: payload.registrationStatus,
      ...(payload.joinCode ? { joinUrl: `skymp://join/${payload.joinCode}` } : {}),
    });
  }

  private scheduleRegistrationRetry(): void {
    if (this.registrationTimer || this.stopping) return;
    this.registrationTimer = setTimeout(() => {
      this.registrationTimer = undefined;
      void this.registerOnce().catch((cause) => {
        this.context?.logger.warn('Directory registration retry failed', { cause: errorMessage(cause) });
        this.scheduleRegistrationRetry();
      });
    }, 30_000);
  }

  private async send(): Promise<void> {
    const context = this.requireContext();
    const status = context.getStatus();
    const body = JSON.stringify({
      descriptor: this.descriptor(status.maxPlayers),
      status: { state: status.state, online: status.online, maxPlayers: status.maxPlayers },
    });
    const serverId = this.backend.server.id;
    if (!serverId) throw new Error('Directory registration has not assigned a server ID');
    const path = `/api/servers/${encodeURIComponent(serverId)}/heartbeat`;
    const timestamp = String(Date.now());
    const nonce = randomBytes(18).toString('base64url');
    const signature = signWithDirectoryIdentity(
      this.requireIdentity(),
      canonicalDirectoryRequest('heartbeat', 'PUT', path, timestamp, nonce, body),
    );
    const response = await fetch(`${this.directoryUrl()}${path}`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        'x-skymp-nonce': nonce,
        'x-skymp-timestamp': timestamp,
        'x-skymp-signature': signature,
      },
      body,
      signal: AbortSignal.timeout(5000),
    });
    if (response.status === 409) this.scheduleRegistrationRetry();
    if (!response.ok) {
      const payload = await response.json().catch(() => ({})) as DirectoryErrorBody;
      throw new Error(payload.error?.message ?? `Directory responded with ${response.status}`);
    }
  }

  private descriptor(maxPlayers = this.backend.server.maxPlayers) {
    return {
      contract: 'directory-managed' as const,
      name: this.backend.server.name,
      description: this.backend.server.description,
      region: this.backend.server.region,
      tags: this.backend.server.tags,
      gamePort: this.backend.server.gamePort,
      resourcesPort: this.backend.server.resourcesPort,
      ...(this.backend.server.hostname ? { hostname: this.backend.server.hostname } : {}),
      visibility: this.backend.server.visibility,
      versions: this.backend.server.versions ?? {},
      maxPlayers,
      access: this.backend.server.access ?? { discordGuild: { required: false } },
      modpack: this.backend.server.modpack
        ? {
          nexusCollection: this.backend.server.modpack.nexusCollection,
          revision: this.backend.server.modpack.revision,
          plugins: this.backend.server.plugins,
          loadOrder: this.backend.server.loadOrder,
          hashes: this.backend.server.modpack.hashes ?? {},
        }
        : undefined,
    };
  }

  private applyStoredRegistration(): void {
    const identity = this.requireIdentity();
    if (identity.serverId) {
      if (this.backend.server.id && this.backend.server.id !== identity.serverId) {
        this.context?.logger.warn('Ignoring stale configured server.id in favor of the Directory ID stored in backend storage', {
          configuredServerId: this.backend.server.id,
          storedServerId: identity.serverId,
        });
      }
      this.backend.server.id = identity.serverId;
    }
    if (identity.directoryPublicKey) {
      const configured = this.backend.sessions.directoryPublicKey;
      if (configured && configured !== identity.directoryPublicKey) {
        throw new Error('Configured Directory signing key does not match the key pinned in backend storage');
      }
      this.backend.sessions.directoryPublicKey = identity.directoryPublicKey;
    }
  }

  private async persistIdentity(): Promise<void> {
    await this.requireContext().database.set('identity', this.requireIdentity());
  }

  private connectorConfig(): DirectoryConfig {
    return this.requireContext().config as unknown as DirectoryConfig;
  }

  private directoryUrl(): string {
    const value = (this.connectorConfig().url ?? 'https://skyservers.online').replace(/\/$/, '');
    const url = new URL(value);
    const loopback = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
      throw new Error('Directory URL must use HTTPS; HTTP is allowed only for loopback development');
    }
    return value;
  }

  private requireIdentity(): StoredDirectoryIdentity {
    if (!this.identity) throw new Error('Directory identity is not initialized');
    return this.identity;
  }

  private requireContext(): ModuleContext {
    if (!this.context) throw new Error('Directory connector is not initialized');
    return this.context;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    if (this.registrationTimer) clearTimeout(this.registrationTimer);
    if (this.context && this.statusListener) this.context.events.off('status', this.statusListener);
    if (this.context && this.backend.server.id) await this.send().catch(() => undefined);
  }
}

class DirectoryRegistrationError extends Error {
  constructor(message: string, readonly retryAt?: number, readonly permanent = false) {
    super(message);
  }
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
