# Coordinated Directory cutover

This release has one contract. Old launchers, pairing/HMAC managed servers and
public operator backends are intentionally incompatible.

1. Deploy the new self-hostable SkyMP-Directory.
2. Publish the matching Frostfall Launcher.
3. Re-run `skymp-buildtool setup managed-server` and restart each server.

The setup updater removes `publicApi`, `publicBackendUrl` and `gameAddress`,
preserves unrelated configuration keys, creates a timestamped backup and writes
the replacement atomically. The Ed25519 server identity and assigned server ID
remain in the backend database.

Directory migration retains Ed25519 identities/server IDs and marks existing
rows offline until their first heartbeat using the final descriptor.
