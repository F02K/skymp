import { logError, logTrace } from '../../logging';
import { MsgType } from '../../messages';
import { ConnectionMessage } from '../events/connectionMessage';
import { CustomPacketMessage } from '../messages/customPacketMessage';
import { ClientListener, CombinedController, Sp } from './clientListener';

export const SERVER_EXTENSION_API_VERSION = 1 as const;

export interface ServerExtensionDefinition {
  id: string;
  apiVersion: typeof SERVER_EXTENSION_API_VERSION;
  activate(context: ServerExtensionContext): void | ServerExtensionLifecycle;
}

export interface ServerExtensionLifecycle {
  connected?(): void;
  disconnected?(): void;
  packet?(type: string, payload: unknown): void;
  cleanup?(): void;
}

export interface ServerExtensionContext {
  readonly skyrimPlatform: Sp;
  send(type: string, payload?: unknown, reliable?: boolean): void;
}

interface ExtensionRegistrationGlobal {
  registerServerExtension?: (definition: ServerExtensionDefinition) => void;
  __skympServerExtensionQueue?: ServerExtensionDefinition[];
}

const definitions = new Map<string, ServerExtensionDefinition>();
let activeHost: ServerExtensionHostService | undefined;

export function installServerExtensionRegistrationApi(): void {
  const root = globalThis as unknown as ExtensionRegistrationGlobal;
  const queued = root.__skympServerExtensionQueue ?? [];
  root.__skympServerExtensionQueue = queued;
  root.registerServerExtension = (definition) => {
    try {
      validateDefinition(definition);
      if (definitions.has(definition.id)) {
        throw new Error(`SkyMP server extension '${definition.id}' is already registered`);
      }
      definitions.set(definition.id, definition);
      activeHost?.activate(definition);
    } catch (cause) {
      logError('ServerExtensionRegistration', cause);
    }
  };
  while (queued.length > 0) {
    root.registerServerExtension(queued.shift()!);
  }
}

export class ServerExtensionHostService extends ClientListener {
  private readonly active = new Map<string, ServerExtensionLifecycle>();

  constructor(private readonly sp: Sp, private readonly controller: CombinedController) {
    super();
    activeHost = this;
    definitions.forEach((definition) => this.activate(definition));
    controller.emitter.on('connectionAccepted', () => this.onConnected());
    controller.emitter.on('connectionDisconnect', () => this.onDisconnected());
    controller.emitter.on('connectionDenied', () => this.onDisconnected());
    controller.emitter.on('connectionFailed', () => this.onDisconnected());
    controller.emitter.on('customPacketMessage', (event) => this.onCustomPacket(event));
  }

  activate(definition: ServerExtensionDefinition): void {
    try {
      const lifecycle = definition.activate({
        skyrimPlatform: this.sp,
        send: (type, payload, reliable = true) => {
          if (typeof type !== 'string' || type.length < 1 || type.length > 100) {
            throw new Error('Client Extension packet type must be between 1 and 100 characters');
          }
          const message: CustomPacketMessage = {
            t: MsgType.CustomPacket,
            contentJsonDump: JSON.stringify({
              customPacketType: 'clientExtension',
              extensionId: definition.id,
              type,
              payload: payload ?? null,
            }),
          };
          this.controller.emitter.emit('sendMessage', {
            message,
            reliability: reliable ? 'reliable' : 'unreliable',
          });
        },
      }) ?? {};
      this.active.set(definition.id, lifecycle);
      logTrace(this, `Activated server extension ${definition.id}`);
    } catch (cause) {
      logError(this, `Activation failed for server extension ${definition.id}`, cause);
    }
  }

  private onConnected(): void {
    this.active.forEach((lifecycle, id) => {
      this.safely(id, 'connected', () => lifecycle.connected?.());
    });
  }

  private onDisconnected(): void {
    this.active.forEach((lifecycle, id) => {
      this.safely(id, 'disconnected', () => lifecycle.disconnected?.());
      this.safely(id, 'cleanup', () => lifecycle.cleanup?.());
    });
    this.active.clear();
    definitions.forEach((definition) => this.activate(definition));
  }

  private onCustomPacket(event: ConnectionMessage<CustomPacketMessage>): void {
    let content: Record<string, unknown>;
    try {
      content = JSON.parse(event.message.contentJsonDump) as Record<string, unknown>;
    } catch {
      return;
    }
    if (content.customPacketType !== 'clientExtension'
      || typeof content.extensionId !== 'string'
      || typeof content.type !== 'string') return;
    const lifecycle = this.active.get(content.extensionId);
    if (!lifecycle) return;
    this.safely(content.extensionId, 'packet', () =>
      lifecycle.packet?.(content.type as string, content.payload));
  }

  private safely(id: string, phase: string, action: () => void): void {
    try {
      action();
    } catch (cause) {
      logError(this, `Server extension ${id} failed during ${phase}`, cause);
    }
  }
}

function validateDefinition(value: ServerExtensionDefinition): void {
  if (!value
    || typeof value.id !== 'string'
    || !/^[a-z0-9][a-z0-9._-]{0,99}$/i.test(value.id)
    || value.apiVersion !== SERVER_EXTENSION_API_VERSION
    || typeof value.activate !== 'function') {
    throw new Error('Invalid SkyMP server extension registration');
  }
}
