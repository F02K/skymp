import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";
import { buildDirectory, repositoryRoot } from "./paths.mjs";
import {
  corepackInvocation,
  npmInvocation,
  resolveExecutable,
  runCapture,
} from "./process.mjs";

function versionTuple(value) {
  return value.replace(/^v/u, "").split(".").map((part) => Number.parseInt(part, 10) || 0);
}

export function versionAtLeast(actual, required) {
  const left = versionTuple(actual);
  const right = versionTuple(required);
  for (let index = 0; index < Math.max(left.length, right.length); ++index) {
    if ((left[index] ?? 0) > (right[index] ?? 0)) return true;
    if ((left[index] ?? 0) < (right[index] ?? 0)) return false;
  }
  return true;
}

export function inspectVcpkgCompilerLog(contents) {
  const text = String(contents);
  const targetMatch = text.match(
    /Detecting compiler hash for triplet x64-windows-sp\.\.\.[\s\S]*?^Compiler found:\s*(.+)$/mu,
  );
  const compilers = [...text.matchAll(/^Compiler found:\s*(.+)$/gmu)]
    .map((match) => match[1].trim().replaceAll("\\", "/"));
  const targetCompiler = (targetMatch?.[1] ?? compilers.at(-1))?.trim().replaceAll("\\", "/");
  const visualStudio2026 = targetCompiler
    && /\/Microsoft Visual Studio\/18\//iu.test(targetCompiler);
  if (visualStudio2026) {
    return {
      status: "error",
      detail: "dependencies were built with Visual Studio 2026; reconfigure to rebuild them with the pinned v143 toolset",
    };
  }
  const visualStudio2022 = targetCompiler
    && /\/Microsoft Visual Studio\/2022\//iu.test(targetCompiler);
  if (visualStudio2022) {
    return {
      status: "ok",
      detail: "Visual Studio 2022 / v143",
    };
  }
  return undefined;
}

async function commandVersion(command, args, pattern) {
  const result = await runCapture(command, args, { cwd: repositoryRoot });
  if (result.error || result.code !== 0) {
    return { available: false, detail: result.error?.message ?? result.stderr.trim() };
  }
  const match = `${result.stdout}\n${result.stderr}`.match(pattern);
  return { available: true, version: match?.[1], detail: result.stdout.trim() };
}

export async function inspectEnvironment(configuration) {
  const checks = [];
  const nodeVersion = process.versions.node;
  checks.push({
    name: "Node.js",
    status: versionAtLeast(nodeVersion, "22.0.0") ? "ok" : "error",
    detail: `v${nodeVersion}${versionAtLeast(nodeVersion, "22.0.0") ? "" : " (22 or newer required)"}`,
  });

  try {
    const npm = await npmInvocation(["--version"]);
    const result = await commandVersion(npm.command, npm.args, /(\d+\.\d+\.\d+)/u);
    checks.push({
      name: "npm",
      status: result.available ? "ok" : "error",
      detail: result.version ?? result.detail ?? "not found",
    });
  } catch (error) {
    checks.push({ name: "npm", status: "error", detail: error.message });
  }

  const yarnExecutable = process.platform === "win32"
    ? undefined
    : await resolveExecutable(["yarn"]);
  if (yarnExecutable) {
      const yarn = await commandVersion(yarnExecutable, ["--version"], /(\d+\.\d+\.\d+)/u);
      checks.push({
        name: "Yarn",
        status: yarn.available ? "ok" : "error",
        detail: yarn.version ?? yarn.detail,
      });
  } else {
    try {
      const corepack = await corepackInvocation(["yarn", "--version"]);
      const yarn = await commandVersion(corepack.command, corepack.args, /(\d+\.\d+\.\d+)/u);
      checks.push({
        name: "Yarn",
        status: yarn.available ? "ok" : "error",
        detail: yarn.available
          ? `${yarn.version} via Corepack`
          : `${yarn.detail}; run corepack yarn --version once to install it`,
      });
    } catch (error) {
      checks.push({
        name: "Yarn",
        status: "error",
        detail: `${error.message}; install Yarn or Corepack`,
      });
    }
  }

  const cmake = await commandVersion("cmake", ["--version"], /cmake version (\d+\.\d+\.\d+)/u);
  checks.push({
    name: "CMake",
    status: cmake.available && cmake.version && versionAtLeast(cmake.version, "3.19.0")
      ? "ok"
      : "error",
    detail: cmake.version ?? cmake.detail ?? "not found",
  });

  const submodules = await runCapture("git", ["submodule", "status"], { cwd: repositoryRoot });
  const uninitialized = submodules.stdout.split(/\r?\n/u).filter((line) => line.startsWith("-"));
  checks.push({
    name: "Git submodules",
    status: submodules.code === 0 && uninitialized.length === 0 ? "ok" : "error",
    detail: submodules.code !== 0
      ? (submodules.stderr.trim() || "unable to inspect")
      : uninitialized.length
        ? `${uninitialized.length} uninitialized; run git submodule update --init --recursive`
        : "initialized",
  });

  if (process.platform === "win32") {
    const cacheGenerator = await readCacheValue("CMAKE_GENERATOR");
    const vswhere = resolve(
      process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
      "Microsoft Visual Studio",
      "Installer",
      "vswhere.exe",
    );
    let visualStudioFound = cacheGenerator === "Visual Studio 17 2022";
    if (!visualStudioFound) {
      try {
        await access(vswhere, constants.F_OK);
        const result = await runCapture(vswhere, [
          "-latest", "-products", "*", "-requires",
          "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
          "-property", "installationVersion",
        ]);
        visualStudioFound = result.code === 0 && result.stdout.trim().startsWith("17.");
      } catch {
        visualStudioFound = false;
      }
    }
    checks.push({
      name: "Visual Studio 2022",
      status: visualStudioFound ? "ok" : "error",
      detail: visualStudioFound ? "C++ toolchain available" : "required C++ workload not detected",
    });

    try {
      const manifestLog = await readFile(
        resolve(buildDirectory, "vcpkg-manifest-install.log"),
        "utf8",
      );
      const vcpkgCompiler = inspectVcpkgCompilerLog(manifestLog);
      if (vcpkgCompiler) {
        checks.push({
          name: "vcpkg compiler",
          ...vcpkgCompiler,
        });
      }
    } catch {
      // A fresh checkout has no manifest log until its first configuration.
    }
  } else {
    checks.push({
      name: "Platform",
      status: "warning",
      detail: `${process.platform} is not an officially supported buildtool UI platform yet`,
    });
  }

  try {
    await access(resolve(buildDirectory, "CMakeCache.txt"), constants.F_OK);
    checks.push({ name: "Build cache", status: "ok", detail: buildDirectory });
  } catch {
    checks.push({ name: "Build cache", status: "warning", detail: "not configured yet" });
  }

  if (configuration.skyrimDir) {
    try {
      await access(resolve(configuration.skyrimDir, "SkyrimSE.exe"), constants.F_OK);
      checks.push({ name: "Skyrim", status: "ok", detail: configuration.skyrimDir });
    } catch {
      checks.push({
        name: "Skyrim",
        status: "error",
        detail: `SkyrimSE.exe not found under ${configuration.skyrimDir}`,
      });
    }
  } else {
    checks.push({
      name: "Skyrim",
      status: "warning",
      detail: "path not configured; data-dependent tests and client install are unavailable",
    });
  }
  return checks;
}

async function readCacheValue(key) {
  try {
    const cache = await readFile(resolve(buildDirectory, "CMakeCache.txt"), "utf8");
    const match = cache.match(new RegExp(`^${key}(?::[^=]+)?=(.*)$`, "mu"));
    return match?.[1]?.trim();
  } catch {
    return undefined;
  }
}

export function formatDoctorReport(checks) {
  const icons = { ok: "[OK]", warning: "[WARN]", error: "[ERROR]" };
  return checks
    .map((check) => `${icons[check.status]} ${check.name}: ${check.detail}`)
    .join("\n");
}
