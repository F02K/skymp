# Running a Server

As you already know Skyrim Multiplayer is releasing public server builds. Here is an instruction on running your own server.

## Installation

### Windows

The server requires `Windows 8.1` / `Windows Server 2012` or higher. It may still launch on older operating systems, but correct work isn't guaranteed.

## Managed operator backend (fork extension)

This fork can package an operator-owned backend without changing the upstream
SkyMP server or its direct launch path. The normal native build includes the
backend. To build and package it explicitly on Windows, run:

```text
skymp-buildtool.cmd package managed-server
```

The command builds `skymp5-server` and `skymp-backend`, copies the backend to
`build/dist/server/backend/`, and creates `launch_managed_server.bat` plus
`launch_managed_server.sh`. Start it with:

```text
skymp-buildtool.cmd run managed-server
```

When `backend.config.json` is absent, the launcher opens a short setup wizard.
It generates the non-secret configuration and persistent Ed25519 server
identity; the managed launch also supplies an internal backend token. The
managed backend registers and sends heartbeats outbound to the selected
Directory. The Directory derives the public source address, assigns the server
ID, and returns its signing key for the backend to pin. No public backend URL,
pairing code, operator exchange endpoint or inbound Directory callback is
required.

Hosting panels can run the same setup without a terminal using the
`skymp-buildtool setup managed-server` command-line options or the supported
`SKYMP_*` environment inputs, including `SKYMP_SERVER_NAME` and
`SKYMP_DIRECTORY_URL`. If `SKYMP_BACKEND_TOKEN` is absent, the backend
generates a temporary internal token for the current run and passes it to SkyMP
without writing it to disk or logs. The authenticated backend API stays on
loopback and must not be forwarded or exposed to the public internet.

`launch_server.bat` and `skymp-buildtool.cmd run server` remain direct/debug
entry points. The legacy `node scripts/package-managed-server.mjs` command
continues to work. See [Authentication Flow](docs_authentication.md) for the
player authentication and ticket lifecycle. Full managed-server setup and
security notes are in `skymp-backend/README.md`.

You obviously need to have 64-bit Windows version since the server is 64-bit program.

You are able to build whole project from sources. Server build would be in `build/dist/server`. Use `launch_server.bat` to launch.

### Linux

Only Windows builds are supported currently.

## Configuration

Once you build the server, you should be able to launch it. But default config values are only usable to verify that server works. After launching the server you will see a server called `My Server` in the master list: https://skymp.io/api/servers. You also will be able to connect, but players from the Internet will not. You need to change the `ip` field in `server-settings.json` to get this functionality to work. This file is placed into `build/dist/server` directory during build.

```json5
{
  "dataDir": "data",
  "loadOrder": [
    "Skyrim.esm",
    "Update.esm",
    "Dawnguard.esm",
    "HearthFires.esm",
    "Dragonborn.esm"
  ],
  "ip": "127.0.0.1", // <=
  "name": "My Server"
}
```

- You may find out your public IP here http://api.ipify.org
- You need to have ports open. Talk to your Internet provider support if you want to open ports. Status of each port can be checked here https://www.yougetsignal.com/tools/open-ports/. You can learn about ports that are really used by the server on [Server Configuration Reference](docs_server_configuration_reference.md) page or to simplify think that it may use any of available ports and protocols.
- If you use `LogMeIn Hamachi` or similar software then just type an IP address you got assigned from it. Your friends who share a "local" network with you will be able to connect, players from the Internet will not.
