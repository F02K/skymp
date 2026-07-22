const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

test("ambient mp types and declaration merging compile", () => {
  const tsc = require.resolve("typescript/bin/tsc");
  const fixture = path.join(__dirname, "types.fixture.ts");
  const result = spawnSync(
    process.execPath,
    [
      tsc,
      "--noEmit",
      "--strict",
      "--skipLibCheck",
      "--target",
      "ES2022",
      "--module",
      "CommonJS",
      "--moduleResolution",
      "Node",
      fixture,
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
