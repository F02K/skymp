import { createHmac } from 'node:crypto';
import type { BackendConfig, BackendModule, ModuleContext } from '../types.js';

interface DirectoryConfig {
  url?: string;
  credentialEnv: string;
  heartbeatIntervalMs?: number;
}

export class DirectoryConnector implements BackendModule {
  readonly manifest = {
    id: 'directory-connector', version: '0.1.0', coreContract: 'managed-backend' as const, dependencies: [], entryPoint: 'builtin',
    configSchema: { type: 'object', required: ['credentialEnv'], properties: { url: { type: 'string' }, credentialEnv: { type: 'string' }, heartbeatIntervalMs: { type: 'number' } } },
  };
  private timer?: NodeJS.Timeout;
  private context?: ModuleContext;
  private statusListener?: () => void;

  constructor(private readonly server: BackendConfig['server']) {}

  async start(context: ModuleContext): Promise<void> {
    this.context = context;
    const config = context.config as unknown as DirectoryConfig;
    if (!config.credentialEnv) throw new Error('Directory connector requires credentialEnv');
    if (!context.getSecret(config.credentialEnv)) throw new Error(`Directory credential ${config.credentialEnv} is not set`);
    await this.send().catch((cause) => context.logger.warn('Initial directory heartbeat failed; continuing fail-open', { cause: String(cause) }));
    this.timer = setInterval(() => void this.send().catch((cause) => context.logger.warn('Directory heartbeat failed', { cause: String(cause) })), config.heartbeatIntervalMs ?? 15000);
    this.statusListener = () => void this.send().catch((cause) => context.logger.warn('Directory status update failed', { cause: String(cause) }));
    context.events.on('status', this.statusListener);
  }

  private async send(): Promise<void> {
    if (!this.context) return;
    const config = this.context.config as unknown as DirectoryConfig;
    const credential = this.context.getSecret(config.credentialEnv)!;
    const status = this.context.getStatus();
    const body = JSON.stringify({
      descriptor: {
        contract: 'directory-managed',
        name: this.server.name, description: this.server.description, region: this.server.region,
        tags: this.server.tags, publicBackendUrl: this.server.publicBackendUrl,
        gameAddress: this.server.gameAddress, visibility: this.server.visibility,
        versions: this.server.versions ?? {}, maxPlayers: status.maxPlayers,
        access: this.server.access ?? { discordGuild: { required: false } },
      },
      status: { state: status.state, online: status.online, maxPlayers: status.maxPlayers },
    });
    const timestamp = String(Date.now());
    const signature = createHmac('sha256', credential).update(`${timestamp}.${body}`).digest('base64url');
    const directoryUrl = config.url ?? 'https://skyservers.online';
    const response = await fetch(`${directoryUrl.replace(/\/$/, '')}/api/servers/${encodeURIComponent(this.server.id)}/heartbeat`, {
      method: 'PUT', headers: { 'content-type': 'application/json', authorization: `Bearer ${credential}`, 'x-skymp-timestamp': timestamp, 'x-skymp-signature': signature }, body,
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`Directory responded with ${response.status}`);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    if (this.context && this.statusListener) this.context.events.off('status', this.statusListener);
    if (this.context) await this.send().catch(() => undefined);
  }
}
