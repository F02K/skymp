import { System, Log } from "./system";
import Axios from "axios";
import { SystemContext } from "./system";
import { ScampServer } from "../scampNative";

export class MasterClient implements System {
  systemName = "MasterClient";

  constructor(
    private log: Log,
    private serverPort: number,
    private backendUrl: string,
    private maxPlayers: number,
    private name: string,
    private serverId: string,
    private backendToken: string,
    private updateIntervalMs = 5000,
    private offlineMode = false
  ) { }

  async initAsync(): Promise<void> {
    this.log(`Using managed backend on ${this.backendUrl}`);
    this.endpoint = `${this.backendUrl}/api/internal/servers/${encodeURIComponent(this.serverId)}/heartbeat`;
  }

  update(): void {
    return;
  }

  async updateAsync(ctx: SystemContext): Promise<void> {
    if (this.offlineMode) {
      return;
    }

    await new Promise((r) => setTimeout(r, this.updateIntervalMs));

    if (this.endpoint) {
      const { name, maxPlayers } = this;
      const online = this.getCurrentOnline(ctx.svr);
      try {
        await Axios.post(this.endpoint, { name, maxPlayers, online }, {
          headers: { Authorization: `Bearer ${this.backendToken}` },
        });
      } catch (e) {
        console.error(`Error updating info on managed backend: ${e}`);
      }
    }
  }

  // connect/disconnect events are not reliable so we do full recalculate
  private getCurrentOnline(svr: ScampServer): number {
    return (svr as any).get(0, "onlinePlayers").length;
  }

  customPacket(): void {
    return;
  }

  private endpoint: string;
}
