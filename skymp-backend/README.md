# SkyMP managed server

The managed backend is a local control plane for one SkyMP server. Its internal
API stays on loopback, supervises the game server and validates Directory play
tickets. When `server.clientPack` is configured, one separate public listener
exposes only the immutable signed Client Pack manifest and ZIP archive.

Run the packaged first-use wizard with:

```powershell
skymp-buildtool.cmd setup managed-server
```

The wizard asks only for ordinary server data, game/resources ports, gamemode,
Data directory, optional `skymp-modcollection.lock.json` and an optional
Directory URL. The default is `https://skyservers.online`. A persistent
Ed25519 identity and the Directory signing-key pin are stored in the local
backend database; there are no pairing codes, HMAC credentials, public backend
URLs or operator exchange endpoints.

`server.gamemode` and `server.dataDirectory` are resolved relative to the
directory containing `backend.config.json`. Load-order entries are resolved
relative to `server.dataDirectory`; explicitly configured absolute plugin paths
are also supported. Every configured directory, gamemode and plugin path is
validated before registration or child-process startup. A configured
`server.modCollectionLock` is loaded before the supervisor exists; every
locked server file is size- and SHA-256-verified and its exact plugin/load order
replaces manual values. Local absolute paths
are never copied implicitly from the machine that built the managed package,
and Directory descriptors expose only plugin basenames.

Registration and heartbeats are outbound signed requests. The Directory derives
the public source IP. An optional hostname is accepted only when it resolves to
that IP.

The launcher puts the Directory ticket directly in SkyMP's `session` field.
SkyMP sends it to `POST /api/internal/servers/:serverId/sessions/validate` on the
loopback backend. First redemption verifies signature, audience, 60-second
window, nonce/JTI replay and guild rules. The same opaque ticket then represents
the twelve-hour reconnect session.

See [Authentication Flow](../docs/docs_authentication.md) for the complete
Discord login, Directory grant, launcher handoff, validation and reconnect
lifecycle.

UDP `server.gamePort` and TCP `server.resourcesPort` are public. A configured
Client Pack adds its own TCP port:

```json
{
  "server": {
    "clientPack": {
      "archive": "./client-pack.zip",
      "host": "0.0.0.0",
      "port": 7779
    }
  }
}
```

The ZIP is fully validated and frozen at backend startup. It may contain only
`client-pack.json`, the required
`Platform/Plugins/skymp-server-extension.js`, and optional files under
`Platform/UI`, `Platform/Fonts` and `Platform/ServerAssets`. Native/game plugin
formats are rejected. `GET /api/client-pack/manifest` and
`GET|HEAD /api/client-pack/archive` are the only public routes on this listener.
The wizard can attempt UPnP/NAT-PMP after consent and always prints exact manual
forwarding instructions for every configured port.

Structured backend, supervisor and child-process output is appended to
`logs/managed-server.jsonl` next to `backend.config.json`. Fields whose names
identify tokens, passwords, credentials or private keys are redacted.
