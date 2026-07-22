#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { buildGamemode, formatError, watchGamemode } from "./builder";
import { checkGamemode } from "./checker";

type Command = "build" | "watch" | "check";

interface CliArguments {
  command: Command;
  configPath?: string;
}

const usage = `Usage: skymp-gamemode <build|watch|check> [--config <path>]

Commands:
  build   Create a minified production gamemode.js
  watch   Rebuild an unminified gamemode.js with inline source maps
  check   Type-check all TypeScript projects with tsc --noEmit
`;

function packageVersion(): string {
  const packagePath = path.resolve(__dirname, "../package.json");
  return JSON.parse(fs.readFileSync(packagePath, "utf8")).version;
}

function parseArguments(args: string[]): CliArguments | "help" | "version" {
  if (args.includes("--help") || args.includes("-h")) {
    return "help";
  }
  if (args.includes("--version") || args.includes("-v")) {
    return "version";
  }
  const command = args[0];
  if (command !== "build" && command !== "watch" && command !== "check") {
    throw new Error("Expected one of: build, watch, check");
  }

  let configPath: string | undefined;
  for (let index = 1; index < args.length; ++index) {
    const argument = args[index];
    if (argument === "--config" || argument === "-c") {
      configPath = args[++index];
      if (!configPath) {
        throw new Error(`${argument} requires a path`);
      }
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  return { command, configPath };
}

async function main(): Promise<void> {
  const parsed = parseArguments(process.argv.slice(2));
  if (parsed === "help") {
    console.log(usage);
    return;
  }
  if (parsed === "version") {
    console.log(packageVersion());
    return;
  }
  if (parsed.command === "build") {
    await buildGamemode(parsed.configPath);
    return;
  }
  if (parsed.command === "check") {
    await checkGamemode(parsed.configPath);
    return;
  }

  const handle = await watchGamemode(parsed.configPath);
  console.log("Watching gamemode sources. Press Ctrl+C to stop.");
  await new Promise<void>((resolve) => {
    const stop = () => resolve();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  await handle.dispose();
}

main().catch((error) => {
  console.error(formatError(error));
  console.error(usage);
  process.exitCode = 1;
});
