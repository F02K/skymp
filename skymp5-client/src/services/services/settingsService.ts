import { ClientListener, CombinedController, Sp } from "./clientListener";
import { logTrace } from "../../logging";

export interface TargetPeer {
  host: string;
  port: number;
  publicKeys?: Record<string, string | undefined>;
}

export type TargetPeerCallback = (targetPeer: TargetPeer) => void;

export class SettingsService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
  }

  public isLauncherManaged(): boolean {
    return this.sp.settings["skymp5-client"]["launchMode"] === "directory-managed";
  }

  public getTargetPeer(callback?: TargetPeerCallback): { targetPeerCached: TargetPeer | null } {
    if (!this.isLauncherManaged()) {
      this.sp.printConsole("Dieser Client muss über einen aktuellen SkyMP Launcher gestartet werden.");
      logTrace(this, "Refusing connection without directory-managed launch marker");
      return { targetPeerCached: null };
    }
    if (!this.targetPeerCache) {
      const host = this.sp.settings["skymp5-client"]["server-ip"];
      const port = Number(this.sp.settings["skymp5-client"]["server-port"]);
      if (typeof host !== "string" || !host || !Number.isInteger(port) || port < 1 || port > 65535) {
        this.sp.printConsole("Dieser Client muss über einen aktuellen SkyMP Launcher gestartet werden.");
        logTrace(this, "Refusing connection with invalid launcher runtime data");
        return { targetPeerCached: null };
      }
      this.targetPeerCache = {
        host,
        port,
        publicKeys: this.sp.settings["skymp5-client"]["server-public-keys"] as Record<string, string | undefined> | undefined,
      };
      logTrace(this, "Using launcher-provided target peer", this.targetPeerCache);
    }
    callback?.(this.targetPeerCache);
    return { targetPeerCached: this.targetPeerCache };
  }

  private targetPeerCache: TargetPeer | null = null;
}
