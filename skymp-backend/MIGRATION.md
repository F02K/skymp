# Frostfall backend migration

The managed core intentionally starts with the minimum connection preset. It
already carries the v2 error envelope, hashed play sessions, legacy SkyMP
heartbeat/session routes, separate public/internal listeners, SQLite and
PostgreSQL storage, the supervisor, and the version-pinned module host.

The existing Frostfall backend remains the source for Discord OAuth, access
policies, signed client distribution and project-specific features until each
is moved behind this module API. Recommended extraction order:

1. Discord identity and access services.
2. Client distribution and launcher updates.
3. Admin dashboard, relay, GitHub deployment and observability.
4. Frostfall-specific content, factions and economy.

During migration, operators should keep the existing service for routes not
implemented by the minimal core. Do not archive Frostfall-Backend until its
chosen modules are running against production data and the launcher contract
tests pass. Gameplay behavior remains in gamemode plugins; only external
integrations belong in backend modules.

Planned official module IDs are `discord-identity`, `discord-roles`,
`admin-dashboard`, `client-distribution`, `launcher-updates`, `news-rules`,
`factions-economy`, `websocket-relay`, `github-deployment`, `observability`,
`backups-notifications`, and `legacy-compatibility`. They are deliberately not
enabled or remotely installed by the core.
