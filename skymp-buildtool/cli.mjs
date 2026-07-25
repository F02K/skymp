#!/usr/bin/env node

import { parseArguments } from "./src/args.mjs";
import { pathToFileURL } from "node:url";
import {
  loadConfiguration,
  parseSettingValue,
  saveLocalConfig,
} from "./src/config.mjs";
import {
  buildAction,
  cleanAction,
  configureAction,
  doctorAction,
  gamemodeAction,
  packageAction,
  previewClean,
  runAction,
  setupAction,
  testAction,
} from "./src/actions.mjs";
import { startTui } from "./src/tui.mjs";
import { createModCollectionLock } from "./src/modcollection.mjs";

export const usage = `SkyMP Buildtool

Usage:
  skymp-buildtool.cmd
  skymp-buildtool.cmd doctor
  skymp-buildtool.cmd config show
  skymp-buildtool.cmd config set <key> <value>
  skymp-buildtool.cmd configure [--profile <name>] [--config <name>] [--set KEY=VALUE] [-- <cmake args...>]
  skymp-buildtool.cmd build [--profile <name>] [--target <target>] [--parallel N] [--test] [-- <cmake args...>]
  skymp-buildtool.cmd test --suite <all|unit|backend|server|gamemode-compiler|buildtool> [--filter <value>]
  skymp-buildtool.cmd package <managed-server|nexus>
  skymp-buildtool.cmd package client-pack <staging-directory> <output.zip>
  skymp-buildtool.cmd gamemode <build|check|watch> --config <path>
  skymp-buildtool.cmd run <server|managed-server> [--setup] [managed server options]
  skymp-buildtool.cmd setup managed-server [managed server options]
  skymp-buildtool.cmd modcollection --collection-export <vortex-export.json> --staging-directory <Vortex staging> --data-directory <Data> [--server-plugins <comma-separated>] --output <lock.json>
  skymp-buildtool.cmd clean --scope <build|node|vcpkg|all> --yes

Global build options:
  --profile <name>       developer, release, server-release, client-release or custom
  --config <name>        Override Debug/Release configuration
  --skyrim-dir <path>    Override the locally configured Skyrim directory
  --set KEY=VALUE        Override a CMake cache option

Managed server setup options:
  --server-name <name>
  --server-description <text>
  --server-tags <comma-separated>
  --game-port <udp-port>
  --resources-port <tcp-port>
  --client-pack <zip-path>
  --client-port <tcp-port>
  --server-hostname <optional-hostname>
  --gamemode <name>
  --data-directory <path>
  --modcollection-lock <path>
  --server-region <region>
  --server-visibility <public|private>
  --server-max-players <number>
  --directory-url <url>
`;

export async function main(argv = process.argv.slice(2)) {
  const parsed = parseArguments(argv);
  if (parsed.options.help) {
    process.stdout.write(usage);
    return 0;
  }
  if (!parsed.command) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      process.stdout.write(usage);
      return 0;
    }
    await startTui();
    return 0;
  }

  const configuration = await loadConfiguration({
    profile: parsed.options.profile,
    configuration: parsed.command === "gamemode" ? undefined : parsed.options.configuration,
    targets: parsed.options.targets,
    parallel: parsed.options.parallel,
    skyrimDir: parsed.options.skyrimDir,
    cmakeOptions: parsed.options.cmakeOptions,
  });

  switch (parsed.command) {
    case "doctor": {
      const result = await doctorAction(configuration);
      return result.success ? 0 : 1;
    }
    case "config":
      return await handleConfig(parsed, configuration);
    case "configure":
      await configureAction(configuration, { extraArguments: parsed.options.passthrough });
      return 0;
    case "build":
      await buildAction(configuration, {
        targets: parsed.options.targets,
        parallel: parsed.options.parallel,
        test: parsed.options.test,
        extraArguments: parsed.options.passthrough,
      });
      return 0;
    case "test":
      await testAction(configuration, {
        suite: parsed.options.suite,
        filter: parsed.options.filter,
      });
      return 0;
    case "package":
      if (!parsed.subcommand) throw new Error("package requires managed-server, nexus or client-pack");
      await packageAction(configuration, parsed.subcommand, {
        parallel: parsed.options.parallel,
        stagingDirectory: parsed.rest[0],
        outputFile: parsed.rest[1],
      });
      return 0;
    case "gamemode":
      await gamemodeAction(
        configuration,
        parsed.subcommand,
        parsed.options.configuration,
        { parallel: parsed.options.parallel },
      );
      return 0;
    case "run":
      if (!parsed.subcommand) throw new Error("run requires server or managed-server");
      await runAction(parsed.subcommand, {
        setup: parsed.options.setup,
        environment: parsed.options.managedEnvironment,
      });
      return 0;
    case "setup":
      if (parsed.subcommand !== "managed-server") throw new Error("setup requires managed-server");
      await setupAction(parsed.subcommand, {
        environment: parsed.options.managedEnvironment,
      });
      return 0;
    case "modcollection": {
      if (
        !parsed.options.collectionExport ||
        !parsed.options.stagingDirectory ||
        !parsed.options.managedEnvironment.SKYMP_DATA_DIRECTORY ||
        !parsed.options.output
      ) {
        throw new Error(
          "modcollection requires --collection-export, --staging-directory, --data-directory and --output",
        );
      }
      const result = await createModCollectionLock({
        collectionExport: parsed.options.collectionExport,
        stagingDirectory: parsed.options.stagingDirectory,
        dataDirectory: parsed.options.managedEnvironment.SKYMP_DATA_DIRECTORY,
        outputFile: parsed.options.output,
        selectedPlugins: parsed.options.serverPlugins,
      });
      process.stdout.write(
        `Created ${result.outputFile} (${result.lock.client.manifest.mods.length} client mods, ${result.lock.server.plugins.length} server plugins)\n`,
      );
      return 0;
    }
    case "clean": {
      const scope = parsed.options.scope;
      if (!scope) throw new Error("clean requires --scope");
      process.stdout.write(`The following data will be removed:\n${previewClean(scope).map((path) => `  ${path}`).join("\n")}\n`);
      await cleanAction(scope, { yes: parsed.options.yes });
      return 0;
    }
    default:
      throw new Error(`Unknown command: ${parsed.command}`);
  }
}

async function handleConfig(parsed, configuration) {
  if (parsed.subcommand === "show" || !parsed.subcommand) {
    process.stdout.write(`${JSON.stringify(configuration.local, null, 2)}\n`);
    return 0;
  }
  if (parsed.subcommand === "set") {
    const [key, rawValue] = parsed.rest;
    if (!key || rawValue === undefined) {
      throw new Error("config set requires <key> <value>");
    }
    const value = parseSettingValue(key, rawValue);
    const saved = await saveLocalConfig({ ...configuration.local, [key]: value });
    process.stdout.write(`${JSON.stringify(saved, null, 2)}\n`);
    return 0;
  }
  throw new Error("config expects show or set");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => { process.exitCode = code; },
    (error) => {
      process.stderr.write(`Error: ${error.message}\n`);
      const summary = error.diagnosticOutput?.length
        ? error.diagnosticOutput
        : error.recentOutput?.slice(-8);
      if (summary?.length) {
        process.stderr.write(`${summary.join("\n")}\n`);
      }
      if (error.logPath) process.stderr.write(`Full log: ${error.logPath}\n`);
      process.exitCode = error.exitCode ?? 1;
    },
  );
}
