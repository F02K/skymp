import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  buildDirectory,
  localConfigPath,
  profilesPath,
} from "./paths.mjs";

const CURRENT_SCHEMA_VERSION = 1;
const ALLOWED_SETTINGS = new Set([
  "defaultProfile",
  "skyrimDir",
  "parallel",
  "customConfiguration",
  "customTargets",
  "customCmakeOptions",
]);

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return fallback;
    }
    throw new Error(`Unable to read JSON from ${path}: ${error.message}`);
  }
}

export function migrateLocalConfig(value = {}) {
  const migrated = { ...value };
  if (migrated.profile && !migrated.defaultProfile) {
    migrated.defaultProfile = migrated.profile;
  }
  delete migrated.profile;
  migrated.schemaVersion = CURRENT_SCHEMA_VERSION;
  return migrated;
}

export function validateLocalConfig(value, profileNames) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Local buildtool configuration must be a JSON object");
  }
  if (value.defaultProfile && !profileNames.includes(value.defaultProfile)) {
    throw new Error(`Unknown default profile: ${value.defaultProfile}`);
  }
  if (value.parallel !== undefined
    && (!Number.isInteger(value.parallel) || value.parallel < 1)) {
    throw new Error("parallel must be a positive integer");
  }
  if (value.customTargets !== undefined
    && (!Array.isArray(value.customTargets)
      || value.customTargets.some((target) => typeof target !== "string"))) {
    throw new Error("customTargets must be an array of strings");
  }
  if (value.customCmakeOptions !== undefined
    && (!value.customCmakeOptions
      || typeof value.customCmakeOptions !== "object"
      || Array.isArray(value.customCmakeOptions))) {
    throw new Error("customCmakeOptions must be an object");
  }
  for (const key of Object.keys(value)) {
    if (key !== "schemaVersion" && !ALLOWED_SETTINGS.has(key)) {
      throw new Error(`Unknown local configuration setting: ${key}`);
    }
  }
}

export async function loadConfiguration(overrides = {}) {
  const definitions = await readJson(profilesPath);
  if (definitions.schemaVersion !== 1 || !definitions.profiles) {
    throw new Error("Unsupported buildtool profile schema");
  }

  const local = migrateLocalConfig(await readJson(localConfigPath, {}));
  const profileNames = Object.keys(definitions.profiles);
  validateLocalConfig(local, profileNames);

  const defaultProfile = overrides.profile
    ?? local.defaultProfile
    ?? definitions.defaultProfile;
  if (!definitions.profiles[defaultProfile]) {
    throw new Error(`Unknown profile: ${defaultProfile}`);
  }

  const profile = structuredClone(definitions.profiles[defaultProfile]);
  if (defaultProfile === "custom") {
    profile.configuration = local.customConfiguration ?? profile.configuration;
    profile.targets = local.customTargets ?? profile.targets;
    profile.cmakeOptions = {
      ...profile.cmakeOptions,
      ...(local.customCmakeOptions ?? {}),
    };
  }
  if (overrides.configuration) {
    profile.configuration = overrides.configuration;
  }
  if (overrides.targets?.length) {
    profile.targets = overrides.targets;
  }
  for (const [key, value] of Object.entries(overrides.cmakeOptions ?? {})) {
    profile.cmakeOptions[key] = value;
  }

  return {
    definitions,
    local,
    profileName: defaultProfile,
    profile,
    skyrimDir: overrides.skyrimDir ?? local.skyrimDir ?? await detectSkyrimDirectory(),
    parallel: overrides.parallel ?? local.parallel,
  };
}

export async function detectSkyrimDirectory() {
  try {
    const cache = await readFile(resolve(buildDirectory, "CMakeCache.txt"), "utf8");
    const cached = cache.match(/^SKYRIM_DIR(?::[^=]+)?=(.+)$/mu)?.[1]?.trim();
    if (cached && cached !== "OFF" && await hasSkyrimExecutable(cached)) {
      return cached;
    }
  } catch {
    // Continue with conventional Steam locations.
  }

  if (process.platform !== "win32") return undefined;
  const roots = [
    process.env["ProgramFiles(x86)"],
    process.env.ProgramFiles,
  ].filter(Boolean);
  for (const root of roots) {
    const candidate = resolve(root, "Steam", "steamapps", "common", "Skyrim Special Edition");
    if (await hasSkyrimExecutable(candidate)) return candidate;
  }
  return undefined;
}

async function hasSkyrimExecutable(directory) {
  try {
    await access(resolve(directory, "SkyrimSE.exe"), constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function saveLocalConfig(value) {
  const definitions = await readJson(profilesPath);
  const migrated = migrateLocalConfig(value);
  validateLocalConfig(migrated, Object.keys(definitions.profiles));
  await mkdir(dirname(localConfigPath), { recursive: true });
  const temporaryPath = `${localConfigPath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(migrated, null, 2)}\n`);
  await rename(temporaryPath, localConfigPath);
  return migrated;
}

export function parseSettingValue(key, rawValue) {
  if (!ALLOWED_SETTINGS.has(key)) {
    throw new Error(`Unknown setting: ${key}`);
  }
  if (key === "parallel") {
    const value = Number(rawValue);
    if (!Number.isInteger(value) || value < 1) {
      throw new Error("parallel must be a positive integer");
    }
    return value;
  }
  if (key === "customTargets") {
    return rawValue ? rawValue.split(",").map((value) => value.trim()).filter(Boolean) : [];
  }
  if (key === "customCmakeOptions") {
    return JSON.parse(rawValue);
  }
  return rawValue;
}
