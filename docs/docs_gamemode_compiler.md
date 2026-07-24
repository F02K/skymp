# Gamemode Compiler

`@skymp/gamemode-compiler` bundles one or more TypeScript plugins into the
CommonJS `gamemode.js` loaded by a SkyMP server. Plugins execute in the listed
order and share `globalThis.mp`, process state, and bundled dependencies.

See the
[`template-plugin`](../skymp5-gamemode-compiler/examples/template-plugin/README.md)
for a complete copy-ready project.

## Setup

Install the package in the gamemode workspace and create
`gamemode.config.json` next to its `package.json`:

```json
{
  "$schema": "./node_modules/@skymp/gamemode-compiler/gamemode.config.schema.json",
  "outfile": "build/gamemode.js",
  "plugins": [
    { "name": "core", "entry": "packages/core/src/index.ts" },
    { "name": "economy", "entry": "packages/economy/src/index.ts" }
  ],
  "external": ["better-sqlite3"]
}
```

All paths are relative to the configuration file. Plugin names must be unique,
entries must be files, and `outfile` must be a separate `.js` file. A custom
configuration location can be passed with `--config <path>`.

## Commands

```bash
npx skymp-gamemode build
npx skymp-gamemode watch
npx skymp-gamemode check
```

From a SkyMP source checkout on Windows, the buildtool first ensures that the
compiler itself is current and then runs the same operations:

```text
skymp-buildtool.cmd gamemode build --config path\to\gamemode.config.json
skymp-buildtool.cmd gamemode check --config path\to\gamemode.config.json
skymp-buildtool.cmd gamemode watch --config path\to\gamemode.config.json
```

`build` emits a minified bundle without a source map. `watch` uses an
incremental esbuild context, emits an unminified bundle with an inline source
map, and recreates the context when the configuration changes. Failed builds
leave the last successful output intact. `check` finds the closest
`tsconfig.json` for every TypeScript entry, deduplicates shared projects, and
runs `tsc --noEmit` for them in parallel. Build and watch deliberately do not
type-check.

Configure the produced file on the server:

```json
{
  "gamemodePath": "./gamemode/build/gamemode.js"
}
```

## Types

Enable the supported public `mp` API in each gamemode TypeScript project:

```json
{
  "compilerOptions": {
    "types": ["@skymp/gamemode-compiler"]
  }
}
```

Projects may augment `MpCustomPropertyMap` and `MpCustomEvents` with TypeScript
declaration merging. Server-only internals such as `_sp3*`, `_setSelf`, `tick`,
and storage bootstrap methods are intentionally not public.

## Externals and deployment

Node built-ins are always external. Normal npm dependencies are included in
the single bundle, while packages named in `external` remain runtime
dependencies. Install those packages in the directory containing
`gamemode.js`, or in a parent `node_modules` directory. Native add-ons must
match the operating system, architecture, and Node ABI used by the server.

Deploy `gamemode.js`, the server configuration, and any external packages. The
server loads the real gamemode path, so relative files, source-map paths, and
normal Node module resolution remain valid.
