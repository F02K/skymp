# SkyMP Managed Backend

This package is the operator-owned layer in front of an unchanged SkyMP server. It starts its database, modules and two isolated APIs before supervising `dist_back/skymp5-server.js`.

## Quick start in a packaged server

1. Copy `backend/backend.config.example.json` to `backend.config.json` and edit the public metadata.
2. Set `SKYMP_MASTER_KEY` and `SKYMP_SESSION_ISSUER_TOKEN` in the service environment.
3. In `server-settings.json`, set `master` to `http://127.0.0.1:3001` and `masterKey` to the same value as `SKYMP_MASTER_KEY`.
4. Run `launch_managed_server.bat` on Windows or `launch_managed_server.sh` on Linux.

`launch_server.bat` remains the unchanged upstream/debug entry point. Directory credentials must only be supplied through the environment named by `credentialEnv`; they are never added to SkyMP settings.

## Modules

Built-in and external modules implement `start(context)` and `stop()`. External modules carry `skymp-module.json`, are explicitly configured by local path, and must be pinned in `modules.lock.json`. There is no remote installation or automatic module update.

The default configuration is intentionally private and enables no optional integration. The Directory connector is fail-open: a Directory outage never prevents the local backend or SkyMP server from running.

## PostgreSQL

Set `database.adapter` to `postgres`, name an environment variable in `connectionStringEnv`, and install the optional `pg` package in the backend directory. SQLite is the dependency-free default.
