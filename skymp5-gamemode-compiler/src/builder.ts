import * as fs from "node:fs";
import * as path from "node:path";
import * as esbuild from "esbuild";
import { loadConfig, ResolvedGamemodeConfig } from "./config";

export type BuildProfile = "production" | "development";

export interface WatchHandle {
  dispose(): Promise<void>;
}

function virtualEntry(config: ResolvedGamemodeConfig): string {
  return config.plugins
    .map((plugin) => `require(${JSON.stringify(plugin.entryPath)});`)
    .join("\n");
}

async function atomicWrite(filePath: string, contents: Uint8Array): Promise<void> {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  await fs.promises.writeFile(temporaryPath, contents);
  try {
    await fs.promises.rename(temporaryPath, filePath);
  } finally {
    await fs.promises.rm(temporaryPath, { force: true });
  }
}

function publisherPlugin(
  config: ResolvedGamemodeConfig,
  onResult?: (success: boolean) => void,
): esbuild.Plugin {
  return {
    name: "skymp-atomic-publisher",
    setup(build) {
      build.onEnd(async (result) => {
        const success = result.errors.length === 0;
        try {
          if (success) {
            const output = result.outputFiles?.find(
              (file) => path.resolve(file.path) === path.resolve(config.outfile),
            );
            if (!output) {
              throw new Error(`esbuild did not produce ${config.outfile}`);
            }
            await atomicWrite(config.outfile, output.contents);
            console.log(
              `Built ${config.outfile} (${output.contents.byteLength} bytes, ${config.plugins.length} plugins)`,
            );
          }
        } catch (error) {
          onResult?.(false);
          throw error;
        }
        onResult?.(success);
      });
    },
  };
}

function buildOptions(
  config: ResolvedGamemodeConfig,
  profile: BuildProfile,
  onResult?: (success: boolean) => void,
): esbuild.BuildOptions {
  return {
    stdin: {
      contents: virtualEntry(config),
      loader: "js",
      resolveDir: config.configDir,
      sourcefile: "skymp-gamemode-entry.js",
    },
    outfile: config.outfile,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    keepNames: true,
    minify: profile === "production",
    sourcemap: profile === "development" ? "inline" : false,
    external: config.external,
    write: false,
    logLevel: "info",
    plugins: [publisherPlugin(config, onResult)],
  };
}

export async function buildGamemode(configPath?: string): Promise<void> {
  const config = loadConfig(configPath);
  await esbuild.build(buildOptions(config, "production"));
}

interface WatchSession {
  config: ResolvedGamemodeConfig;
  context: esbuild.BuildContext;
  initialSuccess: boolean;
}

async function startWatchSession(config: ResolvedGamemodeConfig): Promise<WatchSession> {
  let resolveInitial: (success: boolean) => void = () => undefined;
  const initialResult = new Promise<boolean>((resolve) => {
    resolveInitial = resolve;
  });
  let firstResult = true;
  const context = await esbuild.context(
    buildOptions(config, "development", (success) => {
      if (firstResult) {
        firstResult = false;
        resolveInitial(success);
      }
    }),
  );
  await context.watch();
  const initialSuccess = await initialResult;
  return { config, context, initialSuccess };
}

export async function watchGamemode(configPath?: string): Promise<WatchHandle> {
  const initialConfig = loadConfig(configPath);
  let currentSession = await startWatchSession(initialConfig);
  const configDirectory = path.dirname(initialConfig.configPath);
  const configFileName = path.basename(initialConfig.configPath);
  let disposed = false;
  let debounce: NodeJS.Timeout | undefined;
  let reconfigureChain = Promise.resolve();

  const watcher = fs.watch(configDirectory, (_event, fileName) => {
    if (disposed || (fileName && fileName.toString() !== configFileName)) {
      return;
    }
    if (debounce) {
      clearTimeout(debounce);
    }
    debounce = setTimeout(() => {
      reconfigureChain = reconfigureChain.then(async () => {
        try {
          const nextConfig = loadConfig(initialConfig.configPath);
          const nextSession = await startWatchSession(nextConfig);
          if (!nextSession.initialSuccess) {
            await nextSession.context.dispose();
            console.error("Keeping the previous watch configuration because the new build failed");
            return;
          }
          const previousSession = currentSession;
          currentSession = nextSession;
          await previousSession.context.dispose();
          console.log(`Reloaded configuration from ${nextConfig.configPath}`);
        } catch (error) {
          console.error(`Unable to reload gamemode configuration: ${formatError(error)}`);
        }
      });
    }, 150);
  });

  return {
    async dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      if (debounce) {
        clearTimeout(debounce);
      }
      watcher.close();
      await reconfigureChain;
      await currentSession.context.dispose();
    },
  };
}

export function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
