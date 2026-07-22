# SkyMP Gamemode Compiler

`@skymp/gamemode-compiler` bundles one or more TypeScript/JavaScript plugins
into the single CommonJS `gamemode.js` loaded by a SkyMP server.

A copy-ready project is available in
[`examples/template-plugin`](examples/template-plugin/README.md).

```bash
npm install --save-dev @skymp/gamemode-compiler
npx skymp-gamemode build
npx skymp-gamemode watch
npx skymp-gamemode check
```

Create `gamemode.config.json` in the gamemode workspace:

```json
{
  "$schema": "./node_modules/@skymp/gamemode-compiler/gamemode.config.schema.json",
  "outfile": "build/gamemode.js",
  "plugins": [
    { "name": "core", "entry": "packages/core/src/index.ts" },
    { "name": "economy", "entry": "packages/economy/src/index.ts" }
  ],
  "external": []
}
```

Plugins execute in the listed order and share the global `mp` instance and
process; they are not isolated from each other. All paths are resolved relative
to the configuration file. Normal npm dependencies are bundled. Packages in
`external` must be installed in a `node_modules` directory reachable from the
final output file. Native packages must match the server's platform and Node
ABI.

To enable the global `mp` declarations, add the package to the project's
`tsconfig.json`:

```json
{
  "compilerOptions": {
    "types": ["node", "@skymp/gamemode-compiler"]
  }
}
```

`build` creates a minified Node 22 CommonJS bundle. `watch` reuses an esbuild
context and writes an unminified bundle with inline source maps. It also reloads
valid configuration changes. Builds are published with a temporary file and a
failed build never replaces the last successful bundle. `check` runs
`tsc --noEmit` in parallel for the nearest `tsconfig.json` of every TypeScript
entry, deduplicating plugins in the same project. Build and watch only
transpile; run `check` separately when type safety is required.

Point the SkyMP server's `gamemodePath` at the emitted `gamemode.js`. For
deployment, copy that file and install any configured external dependencies
beside it or in a parent directory. `MpCustomPropertyMap` and `MpCustomEvents`
can be augmented with TypeScript declaration merging for project-specific API.
