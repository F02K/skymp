import { access, readFile, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";
import {
  buildDirectory,
  nodeModuleDirectories,
  repositoryRoot,
  toolRoot,
} from "./paths.mjs";
import { inspectEnvironment, formatDoctorReport } from "./doctor.mjs";
import {
  buildProject,
  configureProject,
} from "./cmake.mjs";
import {
  npmInvocation,
  runLogged,
} from "./process.mjs";

export async function doctorAction(configuration, options = {}) {
  const checks = await inspectEnvironment(configuration);
  const report = formatDoctorReport(checks);
  if (options.print !== false) process.stdout.write(`${report}\n`);
  options.onOutput?.(`${report}\n`);
  return {
    checks,
    success: !checks.some((check) => check.status === "error"),
  };
}

export async function configureAction(configuration, options = {}) {
  return await configureProject(configuration, {
    extraArguments: options.extraArguments ?? [],
    processOptions: options.processOptions,
  });
}

export async function buildAction(configuration, options = {}) {
  const result = await buildProject(configuration, {
    targets: options.targets,
    parallel: options.parallel,
    extraArguments: options.extraArguments ?? [],
    processOptions: options.processOptions,
  });
  if (options.test) {
    await testAction(configuration, {
      suite: "all",
      filter: options.filter,
      processOptions: options.processOptions,
    });
  }
  return result;
}

export async function testAction(configuration, options = {}) {
  const suite = options.suite ?? "all";
  const processOptions = options.processOptions;
  if (suite === "all") {
    const args = ["-C", configuration.profile.configuration, "--verbose"];
    if (options.filter) args.push("-R", options.filter);
    return await runLogged("ctest", args, {
      cwd: buildDirectory,
      label: "test-all",
      ...processOptions,
    });
  }
  if (suite === "unit") {
    const executable = await findUnitExecutable(configuration.profile.configuration);
    return await runLogged(executable, options.filter ? [normalizeUnitFilter(options.filter)] : [], {
      cwd: buildDirectory,
      label: "test-unit",
      ...processOptions,
    });
  }
  if (suite === "backend" || suite === "gamemode-compiler" || suite === "buildtool") {
    const directory = suite === "backend"
      ? resolve(repositoryRoot, "skymp-backend")
      : suite === "gamemode-compiler"
        ? resolve(repositoryRoot, "skymp5-gamemode-compiler")
        : toolRoot;
    const npm = await npmInvocation(["test"]);
    return await runLogged(npm.command, npm.args, {
      cwd: directory,
      label: `test-${suite}`,
      ...processOptions,
    });
  }
  throw new Error(`Unknown test suite: ${suite}`);
}

export async function packageAction(configuration, kind, options = {}) {
  if (kind === "managed-server") {
    const managedConfiguration = withCmakeOptions(configuration, {
      BUILD_MANAGED_BACKEND: "ON",
    });
    return await buildAction(managedConfiguration, {
      targets: ["skymp-managed-server"],
      parallel: options.parallel,
      processOptions: options.processOptions,
    });
  }
  if (kind === "nexus") {
    const nexusConfiguration = withCmakeOptions(configuration, {
      PREPARE_NEXUS_ARCHIVES: "ON",
    });
    return await buildAction(nexusConfiguration, {
      targets: ["prepare_nexus_archives"],
      parallel: options.parallel,
      processOptions: options.processOptions,
    });
  }
  throw new Error(`Unknown package kind: ${kind}`);
}

export async function gamemodeAction(configuration, command, configPath, options = {}) {
  if (!["build", "check", "watch"].includes(command)) {
    throw new Error("Gamemode command must be build, check or watch");
  }
  if (!configPath) {
    throw new Error("Gamemode actions require --config <path>");
  }
  await access(resolve(configPath), constants.F_OK);
  const compilerConfiguration = withCmakeOptions(configuration, {
    BUILD_GAMEMODE_COMPILER: "ON",
  });
  await buildAction(compilerConfiguration, {
    targets: ["skymp5-gamemode-compiler"],
    parallel: options.parallel,
    processOptions: options.processOptions,
  });
  const cli = resolve(repositoryRoot, "skymp5-gamemode-compiler", "dist", "cli.js");
  return await runLogged(process.execPath, [cli, command, "--config", resolve(configPath)], {
    cwd: process.cwd(),
    label: `gamemode-${command}`,
    ...options.processOptions,
  });
}

export async function runAction(kind, options = {}) {
  const serverDirectory = resolve(buildDirectory, "dist", "server");
  if (kind === "server") {
    const entry = resolve(serverDirectory, "dist_back", "skymp5-server.js");
    await access(entry, constants.F_OK).catch(() => {
      throw new Error("Server artifact is missing; build the server first");
    });
    return await runLogged(process.execPath, [entry], {
      cwd: serverDirectory,
      label: "run-server",
      ...options.processOptions,
    });
  }
  if (kind === "managed-server") {
    const entry = resolve(serverDirectory, "backend", "dist", "main.js");
    const configPath = resolve(serverDirectory, "backend.config.json");
    await access(entry, constants.F_OK).catch(() => {
      throw new Error("Managed backend artifact is missing; package the managed server first");
    });
    let backendConfig;
    try {
      backendConfig = JSON.parse(await readFile(configPath, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") backendConfig = null;
      else
      throw new Error(`Unable to read ${configPath}: ${error.message}`);
    }
    const environmentNames = backendConfig ? collectEnvironmentNames(backendConfig) : [];
    const internalTokenEnvironment = backendConfig?.server?.internalTokenEnv;
    const missing = environmentNames.filter(
      (name) => name !== internalTokenEnvironment && !process.env[name],
    );
    if (missing.length) {
      throw new Error(`Required environment variable(s) are missing: ${missing.join(", ")}`);
    }
    if (internalTokenEnvironment && !process.env[internalTokenEnvironment]) {
      const message = `${internalTokenEnvironment} is not set; the backend will generate a temporary token for this session.\n`;
      if (options.processOptions?.display !== false) process.stdout.write(message);
      options.processOptions?.onOutput?.(message);
    }
    return await runLogged(process.execPath, [
      entry,
      "--config",
      "backend.config.json",
      ...(options.setup ? ["--setup"] : []),
    ], {
      cwd: serverDirectory,
      label: "run-managed-server",
      env: {
        ...process.env,
        ...(process.stdin.isTTY ? { SKYMP_SETUP_INTERACTIVE: "1" } : {}),
        ...options.environment,
      },
      ...options.processOptions,
    });
  }
  throw new Error(`Unknown run target: ${kind}`);
}

export async function setupAction(kind, options = {}) {
  if (kind !== "managed-server") throw new Error("setup requires managed-server");
  const serverDirectory = resolve(buildDirectory, "dist", "server");
  const entry = resolve(serverDirectory, "backend", "dist", "setup-cli.js");
  await access(entry, constants.F_OK).catch(() => {
    throw new Error("Managed server package is missing; package the managed server first");
  });
  return await runLogged(process.execPath, [entry, "--config", "backend.config.json"], {
    cwd: serverDirectory,
    label: "setup-managed-server",
    env: {
      ...process.env,
      SKYMP_SETUP_INTERACTIVE: process.stdin.isTTY ? "1" : "0",
      ...options.environment,
    },
    ...options.processOptions,
  });
}

export function previewClean(scope) {
  validateCleanScope(scope);
  const paths = [];
  if (scope === "node" || scope === "all") paths.push(...nodeModuleDirectories);
  if (scope === "vcpkg" || scope === "all") {
    paths.push(`${resolve(repositoryRoot, "vcpkg")} (git clean -xfd)`);
  }
  if (scope === "build" || scope === "all") paths.push(buildDirectory);
  return paths;
}

export async function cleanAction(scope, options = {}) {
  validateCleanScope(scope);
  if (!options.yes) {
    throw new Error("Clean requires explicit confirmation (--yes)");
  }
  if (scope === "node" || scope === "all") {
    for (const directory of nodeModuleDirectories) {
      await rm(directory, { recursive: true, force: true });
    }
  }
  if (scope === "vcpkg" || scope === "all") {
    await runLogged("git", ["-C", resolve(repositoryRoot, "vcpkg"), "clean", "-xfd"], {
      cwd: repositoryRoot,
      label: "clean-vcpkg",
      ...options.processOptions,
    });
  }
  if (scope === "build" || scope === "all") {
    await rm(buildDirectory, { recursive: true, force: true });
  }
}

function withCmakeOptions(configuration, additions) {
  return {
    ...configuration,
    profile: {
      ...configuration.profile,
      cmakeOptions: {
        ...configuration.profile.cmakeOptions,
        ...additions,
      },
    },
  };
}

function validateCleanScope(scope) {
  if (!["build", "node", "vcpkg", "all"].includes(scope)) {
    throw new Error("Clean scope must be build, node, vcpkg or all");
  }
}

function normalizeUnitFilter(filter) {
  return filter.startsWith("[") ? filter : `[${filter}]`;
}

async function findUnitExecutable(configuration) {
  const names = process.platform === "win32" ? ["unit.exe"] : ["unit"];
  const candidates = [
    ...names.map((name) => resolve(buildDirectory, "unit", configuration, name)),
    ...names.map((name) => resolve(buildDirectory, "unit", name)),
  ];
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.F_OK);
      return candidate;
    } catch {
      // Continue.
    }
  }
  throw new Error("Unit test executable not found; build target 'unit' first");
}

function collectEnvironmentNames(value) {
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectEnvironmentNames(item));
  }
  if (!value || typeof value !== "object") return [];
  if (value.enabled === false) return [];
  if (value.id === "directory-connector" && value.config?.autoRegister !== false) {
    const copy = structuredClone(value);
    delete copy.id;
    return collectEnvironmentNames(copy);
  }
  return [...new Set(Object.entries(value).flatMap(([key, child]) => {
    if (key === "connectionStringEnv" && value.adapter !== "postgres") {
      return [];
    }
    if (key.endsWith("Env") && typeof child === "string" && child) {
      return [child];
    }
    return collectEnvironmentNames(child);
  }))];
}
