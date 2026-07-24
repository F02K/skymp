# SkyMP Buildtool

The buildtool is the recommended Windows entry point for configuring, building,
testing and running SkyMP. It requires Node.js 22 but has no npm dependencies of
its own.

Run `skymp-buildtool.cmd` from the repository root to open the interactive
console UI. The same operations are available without a TTY:

```text
skymp-buildtool.cmd doctor
skymp-buildtool.cmd configure --profile developer
skymp-buildtool.cmd build --profile release --parallel 8 --test
skymp-buildtool.cmd build --target unit
skymp-buildtool.cmd test --suite unit --filter Respawn
skymp-buildtool.cmd test --suite server
skymp-buildtool.cmd package managed-server
skymp-buildtool.cmd package client-pack path\to\staging build\packs\my-server.zip
skymp-buildtool.cmd setup managed-server
skymp-buildtool.cmd run managed-server
skymp-buildtool.cmd run managed-server --setup
skymp-buildtool.cmd setup managed-server --server-name "My Server" --game-port 7777 --directory-url https://skyservers.online
skymp-buildtool.cmd setup managed-server --server-name "My Server" --client-pack build\packs\server.zip --client-port 7779
```

Use `skymp-buildtool.cmd --help` for the complete command list.

## Profiles and local configuration

The versioned profiles are `developer`, `release`, `server-release`,
`client-release` and `custom`. `developer` is the default. The tool always uses
the repository's existing `build/` directory and automatically reconfigures
CMake when the selected profile or its relevant settings change.

Local settings are stored in the ignored `.skymp-buildtool.json`:

```text
skymp-buildtool.cmd config set defaultProfile release
skymp-buildtool.cmd config set skyrimDir "F:\Steam\steamapps\common\Skyrim Special Edition"
skymp-buildtool.cmd config set parallel 8
```

Command-line values override local settings, which override profile defaults.
Secrets do not belong in this file. If a managed configuration is missing,
`run managed-server` starts the setup wizard on first use; `setup managed-server` or
`run managed-server --setup` intentionally reruns it.
Noninteractive hosting panels can provide the public values through
`SKYMP_SERVER_*`, `SKYMP_PUBLIC_BACKEND_URL` and `SKYMP_GAME_ADDRESS`.
The persistent Directory identity and stable server ID live in the backend
database and are generated automatically. The internal backend token remains
ephemeral unless explicitly supplied; only PostgreSQL deployments need an
external database secret.

## Safety and diagnostics

`doctor` checks Node.js, npm, Yarn/Corepack, CMake, Git submodules, Visual Studio, the build
cache and the Skyrim path without changing the checkout. Clean operations are
limited to the repository's `build/` directory, known `node_modules`
directories and generated files inside the vcpkg submodule. They print their
targets and require `--yes` outside the interactive UI.

Command output is streamed and retained under `build/logs/skymp-buildtool/`.
Direct CMake, CTest and `build.sh` workflows remain supported.

## Server Client Packs

`package client-pack` creates a byte-reproducible, store-only ZIP from an
already bundled staging directory. The directory must contain
`client-pack.json` and
`Platform/Plugins/skymp-server-extension.js`. Optional files may live only
under `Platform/UI`, `Platform/Fonts` or `Platform/ServerAssets`.

The extension entry point registers API version 1 through
`globalThis.registerServerExtension({ id, apiVersion: 1, activate })`. To be
independent of Skyrim Platform plugin load order, a bundle may queue its
definition before the core loads:

```js
const definition = { id: "example", apiVersion: 1, activate(context) { /* ... */ } };
if (globalThis.registerServerExtension) globalThis.registerServerExtension(definition);
else (globalThis.__skympServerExtensionQueue ??= []).push(definition);
```
