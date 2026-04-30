import Axios from "axios";
import { Settings } from "../settings";
import { Log, System, SystemContext } from "./system";

interface BackendFactionSync {
  assignment?: unknown;
  permissions: string[];
  gameFactions: unknown[];
  factions: unknown[];
}

export class MasterApiFactionSystem implements System {
  systemName = "MasterApiFactionSystem";

  constructor(
    private log: Log,
    private masterUrl: string | null,
    private masterKey: string,
    private offlineMode: boolean) {
  }

  async initAsync(ctx: SystemContext): Promise<void> {
    this.log(
      `MasterApiFactionSystem system assumed that ${this.masterKey} is our address on master`,
    );

    (ctx.svr as any).assignBackendFaction = async (
      profileId: number,
      requirementId: string,
      playerName?: string,
      notes?: string,
    ): Promise<BackendFactionSync> => {
      if (this.offlineMode) throw new Error("Backend faction assignment is unavailable in offline mode");
      return await this.postFaction(profileId, requirementId, playerName, notes);
    };

    (ctx.svr as any).removeBackendFaction = async (
      profileId: number,
      assignmentId: string,
    ): Promise<BackendFactionSync> => {
      if (this.offlineMode) throw new Error("Backend faction removal is unavailable in offline mode");
      return await this.deleteFaction(profileId, assignmentId);
    };
  }

  private async postFaction(
    profileId: number,
    requirementId: string,
    playerName?: string,
    notes?: string,
  ): Promise<BackendFactionSync> {
    const authToken = await this.getAuthToken();
    const response = await Axios.post(
      `${this.masterUrl}/api/servers/${this.masterKey}/profiles/${profileId}/factions`,
      { requirementId, playerName, notes },
      { headers: { "X-Auth-Token": authToken } },
    );
    return this.assertFactionSync(response.data);
  }

  private async deleteFaction(profileId: number, assignmentId: string): Promise<BackendFactionSync> {
    const authToken = await this.getAuthToken();
    const response = await Axios.delete(
      `${this.masterUrl}/api/servers/${this.masterKey}/profiles/${profileId}/factions/${encodeURIComponent(assignmentId)}`,
      { headers: { "X-Auth-Token": authToken } },
    );
    return this.assertFactionSync(response.data);
  }

  private async getAuthToken(): Promise<string> {
    if (!this.masterUrl) throw new Error("Master URL is not configured");
    const settings = await Settings.get();
    const authToken = settings.allSettings.masterApiAuthToken;
    if (typeof authToken !== "string" || !authToken) {
      throw new Error(`Bad masterApiAuthToken setting: ${authToken}`);
    }
    return authToken;
  }

  private assertFactionSync(data: any): BackendFactionSync {
    if (
      !data ||
      !Array.isArray(data.permissions) ||
      !Array.isArray(data.gameFactions) ||
      !Array.isArray(data.factions)
    ) {
      throw new Error(`bad master-api faction response ${JSON.stringify(data)}`);
    }
    return data;
  }
}
