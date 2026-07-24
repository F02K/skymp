import assert from "node:assert/strict";
import test from "node:test";
import { parseArguments } from "../src/args.mjs";

test("parses build options, repeated targets and CMake passthrough", () => {
  const parsed = parseArguments([
    "build",
    "--profile", "release",
    "--target", "skymp5-server",
    "--target", "skymp-managed-server",
    "--parallel", "8",
    "--test",
    "--set", "BUILD_FRONT=ON",
    "--",
    "-DNO_CLEAN_AFTER_BUILD=ON",
  ]);

  assert.equal(parsed.command, "build");
  assert.equal(parsed.options.profile, "release");
  assert.deepEqual(parsed.options.targets, ["skymp5-server", "skymp-managed-server"]);
  assert.equal(parsed.options.parallel, 8);
  assert.equal(parsed.options.test, true);
  assert.deepEqual(parsed.options.cmakeOptions, { BUILD_FRONT: "ON" });
  assert.deepEqual(parsed.options.passthrough, ["-DNO_CLEAN_AFTER_BUILD=ON"]);
});

test("rejects missing and invalid option values", () => {
  assert.throws(() => parseArguments(["build", "--profile"]), /requires a value/u);
  assert.throws(() => parseArguments(["build", "--parallel", "0"]), /positive integer/u);
  assert.throws(() => parseArguments(["build", "--set", "BROKEN"]), /KEY=VALUE/u);
  assert.throws(() => parseArguments(["build", "--unknown"]), /Unknown option/u);
});

test("keeps subcommands and remaining positional values", () => {
  const parsed = parseArguments(["config", "set", "defaultProfile", "release"]);
  assert.equal(parsed.command, "config");
  assert.equal(parsed.subcommand, "set");
  assert.deepEqual(parsed.rest, ["defaultProfile", "release"]);
});

test("parses managed-server setup without treating it as CMake passthrough", () => {
  const parsed = parseArguments([
    "setup", "managed-server",
    "--server-name", "Space Path Server",
    "--game-port", "7777",
    "--resources-port", "7778",
    "--client-pack", "build/server.zip",
    "--client-port", "7779",
    "--server-max-players", "42",
  ]);
  assert.equal(parsed.command, "setup");
  assert.equal(parsed.subcommand, "managed-server");
  assert.deepEqual(parsed.options.managedEnvironment, {
    SKYMP_SERVER_NAME: "Space Path Server",
    SKYMP_GAME_PORT: "7777",
    SKYMP_RESOURCES_PORT: "7778",
    SKYMP_CLIENT_PACK_ARCHIVE: "build/server.zip",
    SKYMP_CLIENT_PACK_PORT: "7779",
    SKYMP_SERVER_MAX_PLAYERS: "42",
  });
});
