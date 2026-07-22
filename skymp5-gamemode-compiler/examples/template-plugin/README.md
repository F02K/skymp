# SkyMP Template Plugin

This is a minimal TypeScript gamemode plugin using
`@skymp/gamemode-compiler`. The compiler bundles `src/index.ts` and its local
imports into one `build/gamemode.js` file.

## Use inside this repository

```bash
npm install --no-save ../..
npm run check
npm run build
```

Use `npm run watch` while developing. Point the SkyMP server configuration at
the generated file:

```json
{
  "gamemodePath": "path/to/template-plugin/build/gamemode.js",
  "templatePlugin": {
    "logConnections": true,
    "logActivations": true
  }
}
```

The local `--no-save` install is only needed while the compiler package is not
published. After copying this directory into a standalone project, install its
declared package version normally:

```bash
npm install
```

Add more plugins by appending entries to `plugins` in
`gamemode.config.json`. They execute in array order and share the same `mp`
instance.
