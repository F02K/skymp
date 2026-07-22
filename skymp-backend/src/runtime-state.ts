import { EventEmitter } from 'node:events';
import type { RuntimeStatus, ServerState } from './types.js';

export class RuntimeState extends EventEmitter {
  private status: RuntimeStatus;
  constructor(maxPlayers: number) {
    super();
    this.status = { state: 'offline', online: 0, maxPlayers, startedAt: Date.now() };
  }
  get(): RuntimeStatus { return { ...this.status }; }
  setState(state: ServerState, fields: Partial<RuntimeStatus> = {}): void {
    this.status = { ...this.status, ...fields, state };
    this.emit('status', this.get());
  }
  heartbeat(online: number, maxPlayers: number): void {
    this.status = { ...this.status, online, maxPlayers, lastHeartbeatAt: Date.now() };
    this.emit('heartbeat', this.get());
    this.emit('status', this.get());
  }
  setChildPid(childPid?: number): void {
    this.status = { ...this.status, childPid };
    this.emit('status', this.get());
  }
}
