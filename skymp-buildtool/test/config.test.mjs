import assert from "node:assert/strict";
import test from "node:test";
import {
  loadConfiguration,
  migrateLocalConfig,
  parseSettingValue,
  validateLocalConfig,
} from "../src/config.mjs";

const profiles = ["developer", "release", "server-release", "client-release", "custom"];

test("migrates legacy profile setting", () => {
  assert.deepEqual(migrateLocalConfig({ profile: "release", parallel: 4 }), {
    defaultProfile: "release",
    parallel: 4,
    schemaVersion: 1,
  });
});

test("validates settings and parses typed values", () => {
  assert.doesNotThrow(() => validateLocalConfig({
    schemaVersion: 1,
    defaultProfile: "developer",
    parallel: 2,
  }, profiles));
  assert.throws(() => validateLocalConfig({ defaultProfile: "missing" }, profiles), /Unknown/u);
  assert.throws(() => validateLocalConfig({ parallel: 0 }, profiles), /positive/u);
  assert.throws(() => validateLocalConfig({ surprise: true }, profiles), /Unknown/u);
  assert.equal(parseSettingValue("parallel", "12"), 12);
  assert.deepEqual(parseSettingValue("customTargets", "unit, skymp5-server"), [
    "unit",
    "skymp5-server",
  ]);
});

test("explicit configuration overrides profile defaults", async () => {
  const configuration = await loadConfiguration({
    profile: "server-release",
    configuration: "RelWithDebInfo",
    targets: ["unit"],
    parallel: 6,
    skyrimDir: "C:\\Games\\Skyrim Special Edition",
    cmakeOptions: { BUILD_UNIT_TESTS: "ON" },
  });
  assert.equal(configuration.profileName, "server-release");
  assert.equal(configuration.profile.configuration, "RelWithDebInfo");
  assert.deepEqual(configuration.profile.targets, ["unit"]);
  assert.equal(configuration.parallel, 6);
  assert.equal(configuration.profile.cmakeOptions.BUILD_UNIT_TESTS, "ON");
});
