const VALUE_OPTIONS = new Set([
  "--profile",
  "--target",
  "--parallel",
  "--suite",
  "--filter",
  "--config",
  "--scope",
  "--set",
  "--skyrim-dir",
  "--server-name",
  "--server-description",
  "--server-tags",
  "--game-port",
  "--resources-port",
  "--client-pack",
  "--client-port",
  "--server-hostname",
  "--gamemode",
  "--data-directory",
  "--nexus-collection",
  "--collection-revision",
  "--server-region",
  "--server-visibility",
  "--server-max-players",
  "--directory-url",
]);

const BOOLEAN_OPTIONS = new Set(["--test", "--yes", "--setup", "--help", "-h"]);

export function parseArguments(argv) {
  const separator = argv.indexOf("--");
  const ownArguments = separator === -1 ? argv : argv.slice(0, separator);
  const passthrough = separator === -1 ? [] : argv.slice(separator + 1);
  const positional = [];
  const options = {
    targets: [],
    cmakeOptions: {},
    managedEnvironment: {},
    passthrough,
  };

  for (let index = 0; index < ownArguments.length; ++index) {
    const argument = ownArguments[index];
    if (VALUE_OPTIONS.has(argument)) {
      const value = ownArguments[++index];
      if (value === undefined) {
        throw new Error(`${argument} requires a value`);
      }
      switch (argument) {
        case "--profile": options.profile = value; break;
        case "--target": options.targets.push(value); break;
        case "--parallel": options.parallel = parsePositiveInteger(value, argument); break;
        case "--suite": options.suite = value; break;
        case "--filter": options.filter = value; break;
        case "--config": options.configuration = value; break;
        case "--scope": options.scope = value; break;
        case "--skyrim-dir": options.skyrimDir = value; break;
        case "--server-name": options.managedEnvironment.SKYMP_SERVER_NAME = value; break;
        case "--server-description": options.managedEnvironment.SKYMP_SERVER_DESCRIPTION = value; break;
        case "--server-tags": options.managedEnvironment.SKYMP_SERVER_TAGS = value; break;
        case "--game-port": options.managedEnvironment.SKYMP_GAME_PORT = String(parsePort(value, argument)); break;
        case "--resources-port": options.managedEnvironment.SKYMP_RESOURCES_PORT = String(parsePort(value, argument)); break;
        case "--client-pack": options.managedEnvironment.SKYMP_CLIENT_PACK_ARCHIVE = value; break;
        case "--client-port": options.managedEnvironment.SKYMP_CLIENT_PACK_PORT = String(parsePort(value, argument)); break;
        case "--server-hostname": options.managedEnvironment.SKYMP_SERVER_HOSTNAME = value; break;
        case "--gamemode": options.managedEnvironment.SKYMP_GAMEMODE = value; break;
        case "--data-directory": options.managedEnvironment.SKYMP_DATA_DIRECTORY = value; break;
        case "--nexus-collection": options.managedEnvironment.SKYMP_NEXUS_COLLECTION = value; break;
        case "--collection-revision": options.managedEnvironment.SKYMP_NEXUS_COLLECTION_REVISION = String(parsePositiveInteger(value, argument)); break;
        case "--server-region": options.managedEnvironment.SKYMP_SERVER_REGION = value; break;
        case "--server-visibility": options.managedEnvironment.SKYMP_SERVER_VISIBILITY = value; break;
        case "--server-max-players": options.managedEnvironment.SKYMP_SERVER_MAX_PLAYERS = String(parsePositiveInteger(value, argument)); break;
        case "--directory-url": options.managedEnvironment.SKYMP_DIRECTORY_URL = value; break;
        case "--set": {
          const equals = value.indexOf("=");
          if (equals < 1) {
            throw new Error("--set expects KEY=VALUE");
          }
          options.cmakeOptions[value.slice(0, equals)] = value.slice(equals + 1);
          break;
        }
      }
      continue;
    }
    if (BOOLEAN_OPTIONS.has(argument)) {
      if (argument === "--test") options.test = true;
      if (argument === "--yes") options.yes = true;
      if (argument === "--setup") options.setup = true;
      if (argument === "--help" || argument === "-h") options.help = true;
      continue;
    }
    if (argument.startsWith("-")) {
      throw new Error(`Unknown option: ${argument}`);
    }
    positional.push(argument);
  }

  return {
    command: positional[0],
    subcommand: positional[1],
    rest: positional.slice(2),
    positional,
    options,
  };
}

function parsePositiveInteger(value, option) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${option} must be a positive integer`);
  }
  return parsed;
}

function parsePort(value, option) {
  const parsed = parsePositiveInteger(value, option);
  if (parsed > 65535) throw new Error(`${option} must be <= 65535`);
  return parsed;
}
