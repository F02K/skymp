# Managed backend cutover

SkyMP uses the managed backend as its operator-owned integration layer.
Discovery and Discord OAuth belong to the mandatory SkyMP Directory. A launcher
requests a server-bound play grant from the Directory and exchanges it at the
selected backend. The backend then exposes the verified profile to SkyMP through
its authenticated loopback listener.

The cutover is intentionally strict:

1. Directory descriptors must declare `contract: "directory-managed"`.
2. Public and internal HTTP endpoints live only below `/api`.
3. Launcher sessions use `Authorization: Bearer`.
4. SkyMP identifies a backend by public server ID and sends the internal token
   in the same header.
5. Optional capabilities are advertised only after their module has started and
   registered the standard handler.

Frostfall-Backend is deprecated and frozen. New integrations belong in
version-pinned managed-backend modules. Gameplay behavior remains in gamemode
plugins.
