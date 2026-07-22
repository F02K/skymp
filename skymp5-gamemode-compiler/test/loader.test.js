const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const esbuild = require("esbuild");

const loaderSource = path.resolve(__dirname, "../../skymp5-server/ts/gamemodeModule.ts");

test("loader reloads local modules, preserves packages, and supports directory entries", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "skymp-gamemode-loader-"));
  t.after(() => {
    delete global.mp;
    delete global.gamemodeResult;
    delete global.externalLoads;
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const compiledLoader = path.join(directory, "loader.cjs");
  esbuild.buildSync({
    entryPoints: [loaderSource],
    outfile: compiledLoader,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
  });
  const { GamemodeModule } = require(compiledLoader);

  const gamemodeDirectory = path.join(directory, "gamemode");
  const packageDirectory = path.join(
    gamemodeDirectory,
    "node_modules",
    "fixture-package",
  );
  fs.mkdirSync(gamemodeDirectory, { recursive: true });
  fs.mkdirSync(packageDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(packageDirectory, "index.js"),
    "global.externalLoads = (global.externalLoads || 0) + 1; module.exports = { token: Math.random() };",
  );
  fs.writeFileSync(path.join(gamemodeDirectory, "relative.js"), "module.exports = 'first';");
  fs.writeFileSync(
    path.join(gamemodeDirectory, "index.js"),
    [
      "const external = require('fixture-package');",
      "global.gamemodeResult = {",
      "  relative: require('./relative'),",
      "  external,",
      "  filename: __filename,",
      "};",
    ].join("\n"),
  );

  let clearCalls = 0;
  const server = { clear: () => clearCalls++ };
  const loader = new GamemodeModule(server, gamemodeDirectory);
  loader.load();
  const firstExternal = global.gamemodeResult.external;

  fs.writeFileSync(path.join(gamemodeDirectory, "relative.js"), "module.exports = 'second';");
  loader.load();

  assert.equal(clearCalls, 2);
  assert.equal(global.gamemodeResult.relative, "second");
  assert.equal(global.gamemodeResult.external, firstExternal);
  assert.equal(global.externalLoads, 1);
  assert.equal(global.gamemodeResult.filename, path.join(gamemodeDirectory, "index.js"));
});
