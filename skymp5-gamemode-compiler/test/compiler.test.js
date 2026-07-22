const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { buildGamemode, checkGamemode, loadConfig, watchGamemode } = require("../dist");

function workspace(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "skymp-gamemode-compiler-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function executeBundle(outfile) {
  delete require.cache[require.resolve(outfile)];
  require(outfile);
}

async function waitFor(predicate, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for condition");
}

test("validates configuration paths and plugin names", (t) => {
  const directory = workspace(t);
  fs.writeFileSync(path.join(directory, "one.ts"), "export {};");
  const configPath = path.join(directory, "custom.json");
  writeJson(configPath, {
    outfile: "build/gamemode.js",
    plugins: [{ name: "one", entry: "one.ts" }],
  });

  const config = loadConfig(configPath);
  assert.equal(config.outfile, path.join(directory, "build", "gamemode.js"));
  assert.equal(config.plugins[0].entryPath, path.join(directory, "one.ts"));

  writeJson(configPath, {
    outfile: "out.js",
    plugins: [
      { name: "same", entry: "one.ts" },
      { name: "same", entry: "one.ts" },
    ],
  });
  assert.throws(() => loadConfig(configPath), /Duplicate plugin name/);

  writeJson(configPath, {
    outfile: "one.ts",
    plugins: [{ name: "one", entry: "one.ts" }],
  });
  assert.throws(() => loadConfig(configPath), /outfile must point to a \.js file/);

  writeJson(configPath, {
    outfile: "out.js",
    plugins: [{ name: "missing", entry: "missing.ts" }],
  });
  assert.throws(() => loadConfig(configPath), /entry does not exist/);

  writeJson(configPath, {
    outfile: "out.js",
    plugins: [{ name: "one", entry: "one.ts" }],
    external: ["./local-file"],
  });
  assert.throws(() => loadConfig(configPath), /npm package name/);
});

test("bundles plugins and npm packages in deterministic order", async (t) => {
  const directory = workspace(t);
  fs.mkdirSync(path.join(directory, "node_modules", "demo-package"), { recursive: true });
  fs.writeFileSync(
    path.join(directory, "node_modules", "demo-package", "index.js"),
    "module.exports = { value: 'bundled' };",
  );
  fs.writeFileSync(
    path.join(directory, "first.ts"),
    "globalThis.__pluginOrder = ['first'];",
  );
  fs.writeFileSync(
    path.join(directory, "second.ts"),
    "const demo = require('demo-package'); globalThis.__pluginOrder.push(demo.value);",
  );
  const configPath = path.join(directory, "gamemode.config.json");
  writeJson(configPath, {
    outfile: "build/gamemode.js",
    plugins: [
      { name: "first", entry: "first.ts" },
      { name: "second", entry: "second.ts" },
    ],
  });

  await buildGamemode(configPath);
  executeBundle(path.join(directory, "build", "gamemode.js"));
  assert.deepEqual(globalThis.__pluginOrder, ["first", "bundled"]);
  assert.doesNotMatch(
    fs.readFileSync(path.join(directory, "build", "gamemode.js"), "utf8"),
    /require\(["']demo-package["']\)/,
  );
  delete globalThis.__pluginOrder;
});

test("keeps explicit external packages resolvable from the real output path", async (t) => {
  const directory = workspace(t);
  fs.mkdirSync(path.join(directory, "node_modules", "external-package"), { recursive: true });
  fs.writeFileSync(
    path.join(directory, "node_modules", "external-package", "index.js"),
    "globalThis.__externalLoads = (globalThis.__externalLoads || 0) + 1; module.exports = 42;",
  );
  fs.writeFileSync(
    path.join(directory, "entry.js"),
    "globalThis.__externalValue = require('external-package');",
  );
  const configPath = path.join(directory, "gamemode.config.json");
  writeJson(configPath, {
    outfile: "build/gamemode.js",
    plugins: [{ name: "external", entry: "entry.js" }],
    external: ["external-package"],
  });

  await buildGamemode(configPath);
  const outfile = path.join(directory, "build", "gamemode.js");
  executeBundle(outfile);
  executeBundle(outfile);
  assert.equal(globalThis.__externalValue, 42);
  assert.equal(globalThis.__externalLoads, 1);
  delete globalThis.__externalValue;
  delete globalThis.__externalLoads;
});

test("does not replace the last good output after a build error", async (t) => {
  const directory = workspace(t);
  const entryPath = path.join(directory, "entry.ts");
  const configPath = path.join(directory, "gamemode.config.json");
  fs.writeFileSync(entryPath, "globalThis.answer = 42;");
  writeJson(configPath, {
    outfile: "build/gamemode.js",
    plugins: [{ name: "core", entry: "entry.ts" }],
  });
  await buildGamemode(configPath);
  const outfile = path.join(directory, "build", "gamemode.js");
  const goodOutput = fs.readFileSync(outfile);

  fs.writeFileSync(entryPath, "const = ;");
  await assert.rejects(buildGamemode(configPath));
  assert.deepEqual(fs.readFileSync(outfile), goodOutput);
});

test("checks each unique TypeScript project", async (t) => {
  const directory = workspace(t);
  fs.writeFileSync(path.join(directory, "one.ts"), "const value: number = 1; void value;");
  fs.writeFileSync(path.join(directory, "two.ts"), "export {};");
  writeJson(path.join(directory, "tsconfig.json"), {
    compilerOptions: { strict: true, target: "ES2022", skipLibCheck: true },
    include: ["*.ts"],
  });
  const configPath = path.join(directory, "gamemode.config.json");
  writeJson(configPath, {
    outfile: "build/gamemode.js",
    plugins: [
      { name: "one", entry: "one.ts" },
      { name: "two", entry: "two.ts" },
    ],
  });
  await checkGamemode(configPath);

  fs.writeFileSync(path.join(directory, "one.ts"), "const value: number = 'bad'; void value;");
  await assert.rejects(checkGamemode(configPath), /TypeScript type checking failed/);
});

test("checks separate TypeScript projects", async (t) => {
  const directory = workspace(t);
  for (const project of ["one", "two"]) {
    const projectDirectory = path.join(directory, project);
    fs.mkdirSync(projectDirectory);
    fs.writeFileSync(path.join(projectDirectory, "index.ts"), "export const valid: number = 1;");
    writeJson(path.join(projectDirectory, "tsconfig.json"), {
      compilerOptions: { strict: true, target: "ES2022", skipLibCheck: true },
      include: ["index.ts"],
    });
  }
  const configPath = path.join(directory, "gamemode.config.json");
  writeJson(configPath, {
    outfile: "build/gamemode.js",
    plugins: [
      { name: "one", entry: "one/index.ts" },
      { name: "two", entry: "two/index.ts" },
    ],
  });
  await checkGamemode(configPath);
});

test("watch rebuilds sources and reloads changed configuration", async (t) => {
  const directory = workspace(t);
  const configPath = path.join(directory, "gamemode.config.json");
  const outfile = path.join(directory, "build", "gamemode.js");
  fs.writeFileSync(path.join(directory, "one.ts"), "globalThis.__watchValue = 'one';");
  fs.writeFileSync(path.join(directory, "two.ts"), "globalThis.__watchValue += '-two';");
  writeJson(configPath, {
    outfile: "build/gamemode.js",
    plugins: [{ name: "one", entry: "one.ts" }],
  });

  const handle = await watchGamemode(configPath);
  t.after(() => handle.dispose());
  await waitFor(() => fs.existsSync(outfile));
  executeBundle(outfile);
  assert.equal(globalThis.__watchValue, "one");

  fs.writeFileSync(path.join(directory, "one.ts"), "globalThis.__watchValue = 'changed';");
  await waitFor(() => fs.readFileSync(outfile, "utf8").includes("changed"));
  executeBundle(outfile);
  assert.equal(globalThis.__watchValue, "changed");

  const lastGoodOutput = fs.readFileSync(outfile);
  fs.writeFileSync(path.join(directory, "one.ts"), "const = ;");
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepEqual(fs.readFileSync(outfile), lastGoodOutput);
  fs.writeFileSync(path.join(directory, "one.ts"), "globalThis.__watchValue = 'recovered';");
  await waitFor(() => fs.readFileSync(outfile, "utf8").includes("recovered"));

  writeJson(configPath, {
    outfile: "build/gamemode.js",
    plugins: [{ name: "missing", entry: "missing.ts" }],
  });
  await new Promise((resolve) => setTimeout(resolve, 250));
  fs.writeFileSync(path.join(directory, "one.ts"), "globalThis.__watchValue = 'after-invalid-config';");
  await waitFor(() => fs.readFileSync(outfile, "utf8").includes("after-invalid-config"));

  writeJson(configPath, {
    outfile: "build/gamemode.js",
    plugins: [
      { name: "one", entry: "one.ts" },
      { name: "two", entry: "two.ts" },
    ],
  });
  await waitFor(() => fs.readFileSync(outfile, "utf8").includes("-two"));
  executeBundle(outfile);
  assert.equal(globalThis.__watchValue, "after-invalid-config-two");
  delete globalThis.__watchValue;
  await handle.dispose();
});
