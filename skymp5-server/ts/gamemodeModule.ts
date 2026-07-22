import * as fs from "node:fs";
import * as path from "node:path";
import type { ScampServer } from "./scampNative";

function isInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function isNodeModule(modulePath: string): boolean {
  return modulePath.split(path.sep).includes("node_modules");
}

export class GamemodeModule {
  private readonly trackedModules = new Set<string>();

  constructor(
    private readonly server: Pick<ScampServer, "clear">,
    private readonly absoluteGamemodePath: string,
  ) {}

  load(): void {
    const resolvedEntry = require.resolve(this.absoluteGamemodePath);
    const gamemodeRoot = fs.statSync(this.absoluteGamemodePath).isDirectory()
      ? this.absoluteGamemodePath
      : path.dirname(resolvedEntry);

    for (const modulePath of this.trackedModules) {
      delete require.cache[modulePath];
    }
    this.trackedModules.clear();
    delete require.cache[resolvedEntry];

    const cacheBeforeLoad = new Set(Object.keys(require.cache));
    this.server.clear();
    const globals = globalThis as unknown as { mp?: Pick<ScampServer, "clear"> };
    globals.mp = globals.mp || this.server;

    try {
      require(resolvedEntry);
    } finally {
      for (const modulePath of Object.keys(require.cache)) {
        if (
          !cacheBeforeLoad.has(modulePath) &&
          isInside(gamemodeRoot, modulePath) &&
          !isNodeModule(modulePath)
        ) {
          this.trackedModules.add(modulePath);
        }
      }
      this.trackedModules.add(resolvedEntry);
    }
  }
}
