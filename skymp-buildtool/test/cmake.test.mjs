import assert from "node:assert/strict";
import test from "node:test";
import {
  buildArguments,
  configurationFingerprint,
  configureArguments,
} from "../src/cmake.mjs";

function configuration() {
  return {
    profileName: "developer",
    skyrimDir: "C:\\Program Files (x86)\\Steam\\Skyrim Special Edition",
    profile: {
      configuration: "Debug",
      targets: ["unit"],
      cmakeOptions: {
        BUILD_UNIT_TESTS: "ON",
        BUILD_MANAGED_BACKEND: "ON",
      },
    },
  };
}

test("passes paths with spaces as one CMake argument", () => {
  const args = configureArguments(configuration(), ["-DTRACE_VALUE=hello world"], false);
  assert.ok(args.includes("-DSKYRIM_DIR=C:\\Program Files (x86)\\Steam\\Skyrim Special Edition"));
  assert.ok(args.includes("-DTRACE_VALUE=hello world"));
  if (process.platform === "win32") {
    assert.deepEqual(args.slice(4, 6), ["-G", "Visual Studio 17 2022"]);
  }
});

test("fingerprint is stable across CMake option insertion order", () => {
  const left = configuration();
  const right = configuration();
  right.profile.cmakeOptions = {
    BUILD_MANAGED_BACKEND: "ON",
    BUILD_UNIT_TESTS: "ON",
  };
  assert.equal(configurationFingerprint(left), configurationFingerprint(right));
  right.profile.configuration = "Release";
  assert.notEqual(configurationFingerprint(left), configurationFingerprint(right));
});

test("build arguments use profile targets unless explicitly overridden", () => {
  assert.deepEqual(buildArguments(configuration(), undefined, 8).slice(-4), [
    "--target", "unit", "--parallel", "8",
  ]);
  assert.ok(buildArguments(configuration(), ["skymp5-server"], undefined).includes("skymp5-server"));
});
