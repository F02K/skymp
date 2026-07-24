# SkyMP managed server

The managed backend is a local control plane for one SkyMP server. It listens
only on loopback, supervises the game server and validates Directory play
tickets. It is never exposed to launchers or to the public internet.

Run the packaged first-use wizard with:

```powershell
skymp-buildtool.cmd setup managed-server
```

The wizard asks only for ordinary server data, game/resources ports, gamemode,
Data directory, plugin load order, optional pinned Nexus Collection and an
optional Directory URL. The default is `https://skyservers.online`. A persistent
Ed25519 identity and the Directory signing-key pin are stored in the local
backend database; there are no pairing codes, HMAC credentials, public backend
URLs or operator exchange endpoints.

Registration and heartbeats are outbound signed requests. The Directory derives
the public source IP. An optional hostname is accepted only when it resolves to
that IP.

The launcher puts the Directory ticket directly in SkyMP's `session` field.
SkyMP sends it to `POST /api/internal/servers/:serverId/sessions/validate` on the
loopback backend. First redemption verifies signature, audience, 60-second
window, nonce/JTI replay and guild rules. The same opaque ticket then represents
the twelve-hour reconnect session.

Only UDP `server.gamePort` and, when used, TCP `server.resourcesPort` are public.
The wizard can attempt UPnP/NAT-PMP after consent and always prints exact manual
forwarding instructions.
