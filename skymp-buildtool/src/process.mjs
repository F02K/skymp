import { spawn } from "node:child_process";
import { access, chmod, mkdir, readdir, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, resolve } from "node:path";
import { createWriteStream } from "node:fs";
import { buildDirectory, logDirectory } from "./paths.mjs";

for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (error) => {
    if (error.code !== "EPIPE") {
      process.exitCode = 1;
    }
  });
}

export function quoteForDisplay(value) {
  const text = String(value);
  return /[\s"]/u.test(text) ? `"${text.replaceAll("\"", "\\\"")}"` : text;
}

export function displayCommand(command, args = []) {
  return [command, ...args].map(quoteForDisplay).join(" ");
}

export function selectDiagnosticOutput(lines, limit = 8) {
  const diagnosticPattern = /\b(?:error|failed|failure|exception)\b|fatal error|LNK\d{4}|MSB\d{4}|CMake Error|npm ERR!/iu;
  const unique = [...new Set(lines.filter((line) => diagnosticPattern.test(line)))];
  if (unique.length <= limit) return unique;
  const leading = Math.ceil(limit / 2);
  const trailing = Math.floor(limit / 2) - 1;
  return [
    ...unique.slice(0, leading),
    `... ${unique.length - leading - trailing} weitere Fehlerzeilen; siehe vollständigen Log ...`,
    ...unique.slice(-trailing),
  ];
}

export async function runCapture(command, args = [], options = {}) {
  return await new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => {
      resolvePromise({ code: null, stdout, stderr, error });
    });
    child.once("exit", (code, signal) => {
      resolvePromise({ code, signal, stdout, stderr });
    });
  });
}

export async function runLogged(command, args = [], options = {}) {
  await mkdir(logDirectory, { recursive: true });
  const timestamp = new Date().toISOString().replaceAll(":", "-");
  const label = (options.label ?? "command").replaceAll(/[^a-zA-Z0-9_-]/gu, "-");
  const logPath = resolve(logDirectory, `${timestamp}-${label}.log`);
  const log = createWriteStream(logPath, { flags: "a" });
  const commandLine = displayCommand(command, args);
  log.write(`$ ${commandLine}\n`);
  if (options.display !== false) {
    process.stdout.write(`\n$ ${commandLine}\n`);
  }
  options.onOutput?.(`$ ${commandLine}\n`);

  return await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      windowsHide: true,
      shell: false,
      stdio: ["inherit", "pipe", "pipe"],
    });
    const recent = [];
    const diagnosticLines = [];
    const consume = (chunk, destination) => {
      const text = chunk.toString();
      log.write(text);
      for (const line of text.split(/\r?\n/u)) {
        if (line) {
          recent.push(line);
          if (selectDiagnosticOutput([line], 1).length) diagnosticLines.push(line);
        }
      }
      if (recent.length > 30) recent.splice(0, recent.length - 30);
      if (options.display !== false && !destination.destroyed && destination.writable) {
        destination.write(text);
      }
      options.onOutput?.(text);
    };
    child.stdout.on("data", (chunk) => consume(chunk, process.stdout));
    child.stderr.on("data", (chunk) => consume(chunk, process.stderr));

    const interrupt = () => {
      if (!child.killed) child.kill("SIGINT");
    };
    process.once("SIGINT", interrupt);

    child.once("error", (error) => {
      process.removeListener("SIGINT", interrupt);
      log.end();
      error.logPath = logPath;
      reject(error);
    });
    child.once("exit", (code, signal) => {
      process.removeListener("SIGINT", interrupt);
      log.end();
      if (code === 0) {
        resolvePromise({ code, signal, logPath });
        return;
      }
      const error = new Error(
        `${options.label ?? command} failed with ${signal ? `signal ${signal}` : `exit code ${code}`}`,
      );
      error.exitCode = code ?? 1;
      error.signal = signal;
      error.logPath = logPath;
      error.recentOutput = recent;
      error.diagnosticOutput = selectDiagnosticOutput(diagnosticLines);
      reject(error);
    });
  });
}

export async function resolveExecutable(names) {
  const candidates = Array.isArray(names) ? names : [names];
  const pathEntries = (process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":");
  const extensions = process.platform === "win32"
    ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")
    : [""];
  for (const name of candidates) {
    if (dirname(name) !== ".") {
      try {
        await access(name, constants.X_OK);
        return name;
      } catch {
        continue;
      }
    }
    for (const entry of pathEntries) {
      if (!entry) continue;
      for (const extension of extensions) {
        const candidate = resolve(entry, process.platform === "win32" && !name.includes(".")
          ? `${name}${extension.toLowerCase()}`
          : name);
        try {
          await access(candidate, constants.F_OK);
          return candidate;
        } catch {
          // Continue searching.
        }
      }
    }
  }
  return undefined;
}

export async function npmInvocation(args = []) {
  if (process.platform !== "win32") {
    return { command: "npm", args };
  }
  const npmCli = resolve(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  await access(npmCli, constants.F_OK);
  return { command: process.execPath, args: [npmCli, ...args] };
}

export async function corepackInvocation(args = []) {
  const corepackCli = resolve(
    dirname(process.execPath),
    "node_modules",
    "corepack",
    "dist",
    "corepack.js",
  );
  await access(corepackCli, constants.F_OK);
  return { command: process.execPath, args: [corepackCli, ...args] };
}

export async function buildEnvironment() {
  if (process.platform !== "win32" && await resolveExecutable(["yarn"])) {
    return process.env;
  }
  let corepack;
  try {
    corepack = await corepackInvocation(["yarn"]);
  } catch (error) {
    if (await resolveExecutable(process.platform === "win32" ? ["yarn.cmd", "yarn"] : ["yarn"])) {
      return process.env;
    }
    throw error;
  }
  const shimDirectory = resolve(buildDirectory, "skymp-buildtool", "bin");
  await mkdir(shimDirectory, { recursive: true });
  if (process.platform === "win32") {
    const shim = resolve(shimDirectory, "yarn.cmd");
    await writeFile(
      shim,
      `@echo off\r\n"${corepack.command}" "${corepack.args[0]}" yarn %*\r\n`,
    );
  } else {
    const shim = resolve(shimDirectory, "yarn");
    await writeFile(
      shim,
      `#!/usr/bin/env sh\nexec "${corepack.command}" "${corepack.args[0]}" yarn "$@"\n`,
    );
    await chmod(shim, 0o755);
  }
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key.toLowerCase() === "path") delete environment[key];
  }
  environment.PATH = `${shimDirectory}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`;
  environment.COREPACK_ENABLE_PROJECT_SPEC = "0";
  return environment;
}

export async function listFiles(directory, suffix) {
  const entries = await readdir(directory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(suffix))
    .map((entry) => resolve(directory, entry.name))
    .sort();
}
