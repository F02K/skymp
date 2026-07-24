import { createHash } from "node:crypto";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";
import {
  buildDirectory,
  repositoryRoot,
  statePath,
} from "./paths.mjs";
import { buildEnvironment, runLogged } from "./process.mjs";

const STATE_SCHEMA_VERSION = 2;
const TOOLCHAIN_REVISION = 2;

export function configurationFingerprint(configuration, extraArguments = []) {
  const stable = JSON.stringify({
    toolchainRevision: TOOLCHAIN_REVISION,
    profileName: configuration.profileName,
    configuration: configuration.profile.configuration,
    cmakeOptions: Object.fromEntries(
      Object.entries(configuration.profile.cmakeOptions).sort(([left], [right]) => left.localeCompare(right)),
    ),
    skyrimDir: configuration.skyrimDir ?? null,
    extraArguments,
  });
  return createHash("sha256").update(stable).digest("hex");
}

export function configureArguments(configuration, extraArguments = [], cacheExists = false) {
  const args = ["-S", repositoryRoot, "-B", buildDirectory];
  if (process.platform === "win32" && !cacheExists) {
    args.push("-G", "Visual Studio 17 2022");
  } else if (process.platform !== "win32") {
    args.push(`-DCMAKE_BUILD_TYPE=${configuration.profile.configuration}`);
  }
  for (const [key, value] of Object.entries(configuration.profile.cmakeOptions)) {
    args.push(`-D${key}=${value}`);
  }
  if (configuration.skyrimDir) {
    args.push(`-DSKYRIM_DIR=${configuration.skyrimDir}`);
  }
  args.push(...extraArguments);
  return args;
}

async function fileExists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function configureProject(configuration, options = {}) {
  await mkdir(buildDirectory, { recursive: true });
  const queryDirectory = resolve(buildDirectory, ".cmake", "api", "v1", "query");
  await mkdir(queryDirectory, { recursive: true });
  await writeFile(resolve(queryDirectory, "codemodel-v2"), "");

  const cacheExists = await fileExists(resolve(buildDirectory, "CMakeCache.txt"));
  const args = configureArguments(configuration, options.extraArguments, cacheExists);
  const environment = await buildEnvironment();
  await runLogged("cmake", args, {
    cwd: repositoryRoot,
    label: "configure",
    ...options.processOptions,
    env: {
      ...environment,
      ...(options.processOptions?.env ?? {}),
    },
  });

  const state = {
    schemaVersion: STATE_SCHEMA_VERSION,
    fingerprint: configurationFingerprint(configuration, options.extraArguments),
    profileName: configuration.profileName,
    configuration: configuration.profile.configuration,
    configuredAt: new Date().toISOString(),
  };
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
  return state;
}

export async function ensureConfigured(configuration, options = {}) {
  const expected = configurationFingerprint(configuration, options.extraArguments);
  try {
    const state = JSON.parse(await readFile(statePath, "utf8"));
    if (state.schemaVersion === STATE_SCHEMA_VERSION
      && state.fingerprint === expected
      && await fileExists(resolve(buildDirectory, "CMakeCache.txt"))) {
      return { configured: false, state };
    }
  } catch {
    // Missing or invalid state requires a fresh configure.
  }
  const state = await configureProject(configuration, options);
  return { configured: true, state };
}

export function buildArguments(configuration, targets, parallel) {
  const args = ["--build", buildDirectory, "--config", configuration.profile.configuration];
  const selectedTargets = targets?.length ? targets : configuration.profile.targets;
  if (selectedTargets.length) {
    args.push("--target", ...selectedTargets);
  }
  if (parallel) {
    args.push("--parallel", String(parallel));
  }
  return args;
}

export async function buildProject(configuration, options = {}) {
  await ensureConfigured(configuration, options);
  const environment = await buildEnvironment();
  return await runLogged(
    "cmake",
    buildArguments(configuration, options.targets, options.parallel ?? configuration.parallel),
    {
      cwd: buildDirectory,
      label: "build",
      ...options.processOptions,
      env: {
        ...environment,
        ...(options.processOptions?.env ?? {}),
      },
    },
  );
}

export async function listCmakeTargets() {
  const replyDirectory = resolve(buildDirectory, ".cmake", "api", "v1", "reply");
  try {
    const files = await readdir(replyDirectory);
    const indexes = files.filter((name) => name.startsWith("index-") && name.endsWith(".json")).sort();
    const index = JSON.parse(await readFile(resolve(replyDirectory, indexes.at(-1)), "utf8"));
    const codemodelReference = index.reply?.["codemodel-v2"]?.jsonFile
      ?? Object.values(index.objects ?? []).find((value) => value.kind === "codemodel")?.jsonFile;
    if (!codemodelReference) return [];
    const codemodel = JSON.parse(await readFile(resolve(replyDirectory, codemodelReference), "utf8"));
    return [...new Set(
      codemodel.configurations.flatMap((entry) => entry.targets.map((target) => target.name)),
    )].sort();
  } catch {
    if (process.platform !== "win32") return [];
    try {
      const projects = await findProjectFiles(buildDirectory);
      return projects.map((path) => path.replace(/.*[\\/]/u, "").replace(/\.vcxproj$/u, "")).sort();
    } catch {
      return [];
    }
  }
}

async function findProjectFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory() && entry.name !== "vcpkg_installed") return await findProjectFiles(path);
    return entry.isFile() && entry.name.endsWith(".vcxproj") ? [path] : [];
  }));
  return nested.flat();
}
