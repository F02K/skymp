import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { loadConfig } from "./config";

const typescriptExtensions = new Set([".ts", ".tsx", ".mts", ".cts"]);

function findTsconfig(entryPath: string): string | undefined {
  let directory = path.dirname(entryPath);
  while (true) {
    const candidate = path.join(directory, "tsconfig.json");
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
    const parent = path.dirname(directory);
    if (parent === directory) {
      return undefined;
    }
    directory = parent;
  }
}

function runTypeScript(tsconfig: string): Promise<boolean> {
  const tscPath = require.resolve("typescript/bin/tsc");
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [tscPath, "--project", tsconfig, "--noEmit", "--pretty", "false"],
      { stdio: "inherit" },
    );
    child.once("error", reject);
    child.once("exit", (code) => resolve(code === 0));
  });
}

export async function checkGamemode(configPath?: string): Promise<void> {
  const config = loadConfig(configPath);
  const tsconfigs = new Set<string>();

  for (const plugin of config.plugins) {
    if (!typescriptExtensions.has(path.extname(plugin.entryPath).toLowerCase())) {
      continue;
    }
    const tsconfig = findTsconfig(plugin.entryPath);
    if (!tsconfig) {
      throw new Error(`No tsconfig.json found for TypeScript plugin ${plugin.name}`);
    }
    tsconfigs.add(tsconfig);
  }

  const results = await Promise.all([...tsconfigs].map(runTypeScript));
  if (results.some((success) => !success)) {
    throw new Error("TypeScript type checking failed");
  }
  console.log(`Checked ${tsconfigs.size} TypeScript project(s)`);
}
