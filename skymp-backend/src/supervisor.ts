import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BackendConfig, Logger } from './types.js';
import type { RuntimeState } from './runtime-state.js';

export class Supervisor {
  private child?: ChildProcess;
  private stopping = false;
  private restartTimer?: NodeJS.Timeout;
  private readonly attempts: number[] = [];
  private readonly pidPath: string;
  private pidHandle?: number;
  private childEnvironment: NodeJS.ProcessEnv = {};
  private readonly outputBuffers = { stdout: '', stderr: '' };

  constructor(
    private readonly config: BackendConfig['supervisor'],
    private readonly state: RuntimeState,
    private readonly logger: Logger,
  ) {
    this.pidPath = join(config.cwd, '.skymp-managed.pid');
  }

  async prepare(): Promise<void> {
    if (this.pidHandle === undefined) this.acquirePidLock();
  }

  async start(environment: NodeJS.ProcessEnv = {}): Promise<void> {
    await this.prepare();
    this.childEnvironment = { ...environment };
    this.stopping = false;
    this.spawnServer();
  }

  private acquirePidLock(): void {
    try {
      this.pidHandle = openSync(this.pidPath, 'wx');
      writeFileSync(this.pidHandle, String(process.pid));
    } catch (cause) {
      let stale = false;
      try {
        const pid = Number(readFileSync(this.pidPath, 'utf8'));
        if (!Number.isInteger(pid) || pid < 1) stale = true;
        else process.kill(pid, 0);
      } catch (probe) {
        stale = (probe as NodeJS.ErrnoException).code === 'ESRCH' || (probe as NodeJS.ErrnoException).code === 'ENOENT';
      }
      if (!stale) throw new Error(`Another managed server may be running; PID lock exists at ${this.pidPath}`, { cause });
      try { unlinkSync(this.pidPath); } catch { /* raced */ }
      this.pidHandle = openSync(this.pidPath, 'wx');
      writeFileSync(this.pidHandle, String(process.pid));
      this.logger.warn('Recovered stale managed-server PID lock', { path: this.pidPath });
    }
  }

  private spawnServer(): void {
    if (this.stopping) return;
    this.state.setState('starting');
    this.logger.info('Starting SkyMP child process', { command: this.config.command, args: this.config.args, cwd: this.config.cwd });
    this.outputBuffers.stdout = '';
    this.outputBuffers.stderr = '';
    const child = spawn(this.config.command, this.config.args, {
      cwd: this.config.cwd,
      env: { ...process.env, ...this.childEnvironment },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
    this.child = child;
    this.state.setChildPid(child.pid);
    child.stdout?.on('data', (chunk) => this.forward('stdout', chunk));
    child.stderr?.on('data', (chunk) => this.forward('stderr', chunk));
    child.once('error', (cause) => {
      this.logger.error('SkyMP process error', { cause: cause.message });
      this.onExit(child, null, null);
    });
    child.once('exit', (code, signal) => this.onExit(child, code, signal));

    const readyTimeout = setTimeout(() => {
      if (this.child === child && this.state.get().state === 'starting') {
        this.logger.error('SkyMP readiness timed out', { timeoutMs: this.config.readyTimeoutMs });
        child.kill('SIGTERM');
      }
    }, this.config.readyTimeoutMs);
    const onHeartbeat = () => {
      clearTimeout(readyTimeout);
      this.state.off('heartbeat', onHeartbeat);
      if (this.child === child && !this.stopping) {
        this.state.setState('online');
        this.logger.info('SkyMP reported ready', { pid: child.pid });
      }
    };
    this.state.on('heartbeat', onHeartbeat);
    child.once('exit', () => {
      clearTimeout(readyTimeout);
      this.state.off('heartbeat', onHeartbeat);
    });
  }

  private forward(stream: 'stdout' | 'stderr', chunk: Buffer): void {
    const lines = `${this.outputBuffers[stream]}${chunk.toString('utf8')}`.split(/\r?\n/);
    this.outputBuffers[stream] = lines.pop() ?? '';
    for (const line of lines.filter(Boolean)) {
      (stream === 'stderr' ? this.logger.warn : this.logger.info)(`skymp: ${line}`, { stream });
    }
  }

  private onExit(child: ChildProcess, code: number | null, signal: NodeJS.Signals | null): void {
    if (this.child !== child) return;
    for (const stream of ['stdout', 'stderr'] as const) {
      const line = this.outputBuffers[stream];
      if (line) {
        (stream === 'stderr' ? this.logger.warn : this.logger.info)(`skymp: ${line}`, { stream });
        this.outputBuffers[stream] = '';
      }
    }
    this.child = undefined;
    this.state.setChildPid(undefined);
    if (this.stopping) {
      this.state.setState('offline');
      return;
    }
    this.state.setState('crashed');
    this.logger.error('SkyMP child process exited', { code, signal });
    if (!this.config.restart.enabled) return;
    const now = Date.now();
    while (this.attempts.length && this.attempts[0] < now - this.config.restart.windowMs) this.attempts.shift();
    if (this.attempts.length >= this.config.restart.maxAttempts) {
      this.logger.error('SkyMP restart limit reached', { attempts: this.attempts.length, windowMs: this.config.restart.windowMs });
      return;
    }
    this.attempts.push(now);
    const delay = Math.min(this.config.restart.initialDelayMs * 2 ** (this.attempts.length - 1), this.config.restart.maxDelayMs);
    this.state.setState('restart-backoff');
    this.logger.warn('Scheduling SkyMP restart', { attempt: this.attempts.length, delayMs: delay });
    this.restartTimer = setTimeout(() => this.spawnServer(), delay);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.state.setState('draining');
    const child = this.child;
    if (child && child.exitCode === null) {
      child.kill('SIGTERM');
      const exited = await Promise.race([
        new Promise<boolean>((resolve) => child.once('exit', () => resolve(true))),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), this.config.shutdownTimeoutMs)),
      ]);
      if (!exited && child.pid) await this.killTree(child.pid);
    }
    this.releasePidLock();
    this.state.setState('offline');
  }

  private async killTree(pid: number): Promise<void> {
    this.logger.warn('Force-stopping SkyMP process tree', { pid });
    if (process.platform === 'win32') {
      await new Promise<void>((resolve) => spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }).once('exit', () => resolve()));
    } else {
      try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* already stopped */ } }
    }
  }

  private releasePidLock(): void {
    if (this.pidHandle !== undefined) {
      closeSync(this.pidHandle);
      this.pidHandle = undefined;
    }
    try { unlinkSync(this.pidPath); } catch { /* absent */ }
  }
}
