import * as fs from "node:fs";
import * as path from "node:path";
import * as chokidar from "chokidar";
import { ScampServer } from "./scampNative";
import { GamemodeModule } from "./gamemodeModule";

export interface GamemodeLoaderOptions {
  reloadDelayMs?: number;
}

function errorText(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }
  return String(error);
}

export class GamemodeLoader {
  private readonly absoluteGamemodePath: string;
  private readonly reloadDelayMs: number;
  private readonly gamemodeModule: GamemodeModule;
  private watcher: chokidar.FSWatcher | undefined;
  private reloadTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly server: ScampServer,
    gamemodePath: string,
    options: GamemodeLoaderOptions = {},
  ) {
    this.absoluteGamemodePath = path.resolve(gamemodePath);
    this.reloadDelayMs = options.reloadDelayMs ?? 1000;
    this.gamemodeModule = new GamemodeModule(server, this.absoluteGamemodePath);
  }

  get path(): string {
    return this.absoluteGamemodePath;
  }

  load(): void {
    try {
      this.gamemodeModule.load();
    } catch (error) {
      if (String(error).includes("'JsRun' returned error 0x30002")) {
        console.log("Bad syntax, ignoring");
        return;
      }
      throw error;
    }
  }

  start(): void {
    console.log(`Gamemode path is "${this.absoluteGamemodePath}"`);
    if (!fs.existsSync(this.absoluteGamemodePath)) {
      console.log(
        `Error during loading a gamemode from "${this.absoluteGamemodePath}" - file or directory does not exist`,
      );
      return;
    }

    try {
      this.load();
    } catch (error) {
      console.error(errorText(error));
    }

    const watchPath = fs.statSync(this.absoluteGamemodePath).isDirectory()
      ? this.absoluteGamemodePath
      : path.dirname(this.absoluteGamemodePath);
    this.watcher = chokidar.watch(watchPath, {
      ignored: /(^|[/\\])(\..|node_modules)([/\\]|$)/,
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: true,
    });

    const scheduleReload = () => {
      if (this.reloadTimer) {
        clearTimeout(this.reloadTimer);
      }
      this.reloadTimer = setTimeout(() => {
        this.reloadTimer = undefined;
        try {
          this.load();
        } catch (error) {
          console.error(errorText(error));
        }
      }, this.reloadDelayMs);
    };

    this.watcher.on("add", scheduleReload);
    this.watcher.on("addDir", scheduleReload);
    this.watcher.on("change", scheduleReload);
    this.watcher.on("unlink", scheduleReload);
    this.watcher.on("unlinkDir", scheduleReload);
    this.watcher.on("error", (error) => {
      console.error("Error happened in chokidar watch", error);
    });
  }

  async stop(): Promise<void> {
    if (this.reloadTimer) {
      clearTimeout(this.reloadTimer);
      this.reloadTimer = undefined;
    }
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = undefined;
    }
  }
}

export function setupGamemode(server: ScampServer, gamemodePath: string): GamemodeLoader {
  const loader = new GamemodeLoader(server, gamemodePath);
  loader.start();
  return loader;
}
