import * as fs from "node:fs";
import * as path from "node:path";

export const defaultConfigFileName = "gamemode.config.json";

export interface GamemodePluginConfig {
  name: string;
  entry: string;
}

export interface GamemodeConfigFile {
  $schema?: string;
  outfile: string;
  plugins: GamemodePluginConfig[];
  external?: string[];
}

export interface ResolvedGamemodePluginConfig extends GamemodePluginConfig {
  entryPath: string;
}

export interface ResolvedGamemodeConfig {
  configPath: string;
  configDir: string;
  outfile: string;
  plugins: ResolvedGamemodePluginConfig[];
  external: string[];
}

function assertString(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
}

function assertKnownKeys(value: object, allowed: Set<string>, field: string): void {
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) {
    throw new Error(`${field} contains unknown property ${unknown}`);
  }
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => {
    const resolved = path.resolve(value);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

function isPackageName(value: string): boolean {
  return /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/i.test(value);
}

export function resolveConfigPath(configPath?: string): string {
  return path.resolve(configPath ?? defaultConfigFileName);
}

export function loadConfig(configPath?: string): ResolvedGamemodeConfig {
  const absoluteConfigPath = resolveConfigPath(configPath);
  let rawConfig: unknown;

  try {
    rawConfig = JSON.parse(fs.readFileSync(absoluteConfigPath, "utf8"));
  } catch (error) {
    throw new Error(`Unable to read ${absoluteConfigPath}`, { cause: error });
  }

  if (!rawConfig || typeof rawConfig !== "object" || Array.isArray(rawConfig)) {
    throw new Error("Gamemode configuration must be a JSON object");
  }

  const config = rawConfig as Partial<GamemodeConfigFile>;
  assertKnownKeys(config, new Set(["$schema", "outfile", "plugins", "external"]), "configuration");
  if (config.$schema !== undefined) {
    assertString(config.$schema, "$schema");
  }
  assertString(config.outfile, "outfile");
  if (path.extname(config.outfile).toLowerCase() !== ".js") {
    throw new Error("outfile must point to a .js file");
  }
  if (!Array.isArray(config.plugins) || config.plugins.length === 0) {
    throw new Error("plugins must contain at least one plugin");
  }
  if (config.external !== undefined && !Array.isArray(config.external)) {
    throw new Error("external must be an array of package names");
  }

  const configDir = path.dirname(absoluteConfigPath);
  const outfile = path.resolve(configDir, config.outfile);
  const pluginNames = new Set<string>();
  const plugins = config.plugins.map((plugin, index) => {
    if (!plugin || typeof plugin !== "object" || Array.isArray(plugin)) {
      throw new Error(`plugins[${index}] must be an object`);
    }
    assertKnownKeys(plugin, new Set(["name", "entry"]), `plugins[${index}]`);
    assertString(plugin.name, `plugins[${index}].name`);
    assertString(plugin.entry, `plugins[${index}].entry`);
    if (pluginNames.has(plugin.name)) {
      throw new Error(`Duplicate plugin name: ${plugin.name}`);
    }
    pluginNames.add(plugin.name);

    const entryPath = path.resolve(configDir, plugin.entry);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(entryPath);
    } catch (error) {
      throw new Error(`Plugin entry does not exist: ${entryPath}`, { cause: error });
    }
    if (!stat.isFile()) {
      throw new Error(`Plugin entry is not a file: ${entryPath}`);
    }
    if (samePath(entryPath, outfile)) {
      throw new Error(`Plugin entry and outfile must differ: ${entryPath}`);
    }

    return { name: plugin.name, entry: plugin.entry, entryPath };
  });

  const external = (config.external ?? []).map((packageName, index) => {
    assertString(packageName, `external[${index}]`);
    if (!isPackageName(packageName)) {
      throw new Error(`external[${index}] must be an npm package name`);
    }
    return packageName;
  });
  if (new Set(external).size !== external.length) {
    throw new Error("external must not contain duplicates");
  }

  return {
    configPath: absoluteConfigPath,
    configDir,
    outfile,
    plugins,
    external,
  };
}
