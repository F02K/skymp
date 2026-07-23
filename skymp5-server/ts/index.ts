import * as ui from "./ui";
import { setupGamemode } from "./gamemodeLoader";

// @ts-ignore
import * as sourceMapSupport from "source-map-support";
sourceMapSupport.install({
  retrieveSourceMap: function (source: string) {
    if (source.endsWith('skymp5-server.js')) {
      return {
        url: 'original.js',
        map: require('fs').readFileSync('dist_back/skymp5-server.js.map', 'utf8')
      };
    }
    return null;
  }
});

import * as scampNative from "./scampNative";
import { Settings } from "./settings";
import { System } from "./systems/system";
import { MasterClient } from "./systems/masterClient";
import { Spawn } from "./systems/spawn";
import { Login } from "./systems/login";
import { DiscordBanSystem } from "./systems/discordBanSystem";
import { MasterApiBalanceSystem } from "./systems/masterApiBalanceSystem";
import { EventEmitter } from "events";
import { pid } from "process";

import * as manifestGen from "./manifestGen";
import { createScampServer } from "./scampNative";
import { MetricsSystem, tickDurationHistogram, tickDurationSummary } from "./systems/metricsSystem";

const setupStreams = (scampNative: any) => {
  class LogsStream {
    constructor(private logLevel: string) {
    }

    write(chunk: Buffer, encoding: string, callback: () => void) {
      // @ts-ignore
      const str = chunk.toString(encoding);
      if (str.trim().length > 0) {
        scampNative.writeLogs(this.logLevel, str);
      }
      callback();
    }
  }

  const infoStream = new LogsStream('info');
  const errorStream = new LogsStream('error');
  // @ts-ignore
  process.stdout.write = (chunk: Buffer, encoding: string, callback: () => void) => {
    infoStream.write(chunk, encoding, callback);
  };
  // @ts-ignore
  process.stderr.write = (chunk: Buffer, encoding: string, callback: () => void) => {
    errorStream.write(chunk, encoding, callback);
  };
};

const main = async () => {
  const settingsObject = await Settings.get();
  const {
    port, backend, maxPlayers, name, offlineMode, gamemodePath
  } = settingsObject;
  if (!backend) throw new Error("Managed backend configuration is required");
  const backendToken = process.env[backend.tokenEnv]!;

  const log = console.log;
  const systems = new Array<System>();
  systems.push(
    new MetricsSystem(),
    new MasterClient(log, port, backend.url, maxPlayers, name, backend.serverId, backendToken, 5000, offlineMode),
    new Spawn(log),
    new Login(log, maxPlayers, backend.url, port, backend.serverId, backendToken, offlineMode),
    new DiscordBanSystem(),
    new MasterApiBalanceSystem(log, maxPlayers, backend.url, port, backend.serverId, backendToken, offlineMode),
  );

  setupStreams(scampNative.getScampNative());

  manifestGen.generateManifest(settingsObject);
  ui.main(settingsObject);

  let server: any;

  try {
    server = createScampServer(settingsObject.allSettings);
    ui.setServer(server);
  } catch (e) {
    console.error(e);
    console.error(`Stopping the server due to the previous error`);
    process.exit(-1);
  }
  const ctx = { svr: server, gm: new EventEmitter() };

  console.log(`Current process ID is ${pid}`);

  (async () => {
    while (1) {
      const endTimerHistogram = tickDurationHistogram.startTimer();
      const endTimerSummary = tickDurationSummary.startTimer();
      try {
        server.tick();
        await new Promise((r) => setTimeout(r, 1));
      } catch (e) {
        console.error(`in server.tick:\n${e.stack}`);
      } finally {
        endTimerHistogram();
        endTimerSummary();
      }
    }
  })();

  for (const system of systems) {
    if (system.initAsync) {
      await system.initAsync(ctx);
    }
    log(`Initialized ${system.systemName}`);
    if (system.updateAsync)
      (async () => {
        while (1) {
          await new Promise((r) => setTimeout(r, 1));
          try {
            await system.updateAsync(ctx);
          } catch (e) {
            console.error(e);
          }
        }
      })();
  }

  server.on("connect", (userId: number) => {
    log("connect", userId);
    for (const system of systems) {
      try {
        if (system.connect) {
          system.connect(userId, ctx);
        }
      } catch (e) {
        console.error(e);
      }
    }
  });

  server.on("disconnect", (userId: number) => {
    log("disconnect", userId);
    for (const system of systems) {
      try {
        if (system.disconnect) {
          system.disconnect(userId, ctx);
        }
      } catch (e) {
        console.error(e);
      }
    }
  });

  server.on("customPacket", (userId: number, rawContent: string) => {
    const content = JSON.parse(rawContent);

    const type = `${content.customPacketType}`;
    delete content.customPacketType;

    for (const system of systems) {
      try {
        if (system.customPacket)
          system.customPacket(userId, type, content, ctx);
      } catch (e) {
        console.error(e);
      }
    }
  });

  server.on("customPacket", (userId: number, content: string) => {
    // At this moment we don't have any custom packets
  });

  // It's important to call this before gamemode
  try {
    server.attachSaveStorage();
  } catch (e) {
    console.error(e);
    console.error(`Stopping the server due to the previous error`);
    process.exit(-1);
  }

  setupGamemode(server, gamemodePath);
};

main();

// This is needed at least to handle axios errors in masterClient
// TODO: implement alerts
process.on("unhandledRejection", (...args) => {
  console.error("[!!!] unhandledRejection")
  console.error(...args);
});

// setTimeout on gamemode should not be able to kill the entire server
// TODO: implement alerts
process.on("uncaughtException", (...args) => {
  console.error("[!!!] uncaughtException")
  console.error(...args);
});
