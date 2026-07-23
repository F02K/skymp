import { System, Log, Content, SystemContext } from "./system";
import * as fetchRetry from "fetch-retry";
import { loginsCounter, loginErrorsCounter } from "./metricsSystem";

const loginFailedBanned = JSON.stringify({ customPacketType: "loginFailedBanned" });
const loginFailedSessionNotFound = JSON.stringify({ customPacketType: "loginFailedSessionNotFound" });

interface UserProfile {
  id: number;
  discordId: string | null;
  username?: string;
  roles?: string[];
}

// See also NetworkingCombined.h
// In NetworkingCombined.h, we implement a hack to prevent the soul-transmission bug
// TODO: reimplement Login system. Preferably, in C++ with clear data flow.
export class Login implements System {
  systemName = "Login";

  constructor(
    private log: Log,
    private maxPlayers: number,
    private backendUrl: string,
    private serverPort: number,
    private serverId: string,
    private backendToken: string,
    private offlineMode: boolean
  ) { }

  private getFetchOptions(callerFunctionName: string) {
    return {
      // retry on any network error, or 5xx status codes
      retryOn: (attempt: number, error: Error | null, response: Response) => {
        const retry = error !== null || response.status >= 500;
        if (retry) {
          console.log(`${callerFunctionName}: retrying request ${JSON.stringify({ attempt, error, status: response.status })}`);
        }
        return retry;
      },
      retries: 10
    };
  }

  private async getUserProfile(session: string, userId: number, ctx: SystemContext): Promise<UserProfile> {
    const response = await this.fetchRetry(
      `${this.backendUrl}/api/internal/servers/${encodeURIComponent(this.serverId)}/sessions/${encodeURIComponent(session)}`,
      {
        ...this.getFetchOptions('getUserProfile'),
        headers: { Authorization: `Bearer ${this.backendToken}` },
      },
    );

    if (!response.ok) {
      if (response.status === 404) {
        ctx.svr.sendCustomPacket(userId, loginFailedSessionNotFound);
      }
      throw new Error(`getUserProfile: HTTP error ${response.status}`);
    }

    const data = await response.json();

    if (!data || !data.user || !data.user.id) {
      throw new Error(`getUserProfile: bad managed-backend response ${JSON.stringify(data)}`);
    }

    return data.user as UserProfile;
  }

  async initAsync(ctx: SystemContext): Promise<void> {
    this.log(`Login system uses managed backend server ${this.serverId}`);
  }

  disconnect(userId: number): void {
  }

  customPacket(
    userId: number,
    type: string,
    content: Content,
    ctx: SystemContext,
  ): void {
    if (type !== "loginWithLauncherSession") {
      return;
    }

    const ip = ctx.svr.getUserIp(userId);
    console.log(`Connecting a user ${userId} with ip ${ip}`);

    const gameData = content["gameData"];
    if (this.offlineMode === true && gameData && gameData.session) {
      this.log("The server is in offline mode, the client is NOT");
    } else if (this.offlineMode === false && gameData && gameData.session) {
      (async () => {
        this.emit(ctx, "userAssignSession", userId, gameData.session);

        const guidBeforeAsyncOp = ctx.svr.getUserGuid(userId);
        const profile = await this.getUserProfile(gameData.session, userId, ctx);
        const guidAfterAsyncOp = ctx.svr.isConnected(userId) ? ctx.svr.getUserGuid(userId) : "<disconnected>";

        console.log({ guidBeforeAsyncOp, guidAfterAsyncOp, op: "getUserProfile" });

        if (guidBeforeAsyncOp !== guidAfterAsyncOp) {
          console.error(`User ${userId} changed guid from ${guidBeforeAsyncOp} to ${guidAfterAsyncOp} during async getUserProfile`);
          throw new Error("Guid mismatch after getUserProfile");
        }

        console.log("getUserProfileId:", profile);

        if ((ctx.svr as any).onLoginAttempt) {
          const isContinue = (ctx.svr as any).onLoginAttempt(profile.id);
          if (!isContinue) {
            ctx.svr.sendCustomPacket(userId, loginFailedBanned);
            throw new Error("Banned by gamemode");
          }
        }


        const roles = Array.isArray(profile.roles) ? [...new Set(profile.roles)] : [];
        this.emit(ctx, "spawnAllowed", userId, profile.id, roles, profile.discordId);
        loginsCounter.inc();
        this.log("Logged as " + profile.id);
      })()
        .catch((err) => {
          loginErrorsCounter.inc({ reason: err?.message || "unknown" });
          console.error("Error logging in client:", JSON.stringify(gameData), err)
        });
    } else if (this.offlineMode === true && gameData && typeof gameData.profileId === "number") {
      const profileId = gameData.profileId;
      this.emit(ctx, "spawnAllowed", userId, profileId, [], undefined);
      loginsCounter.inc();
      this.log(userId + " logged as " + profileId);
    } else {
      this.log("No credentials found in gameData:", gameData);
    }
  }

  private emit(ctx: SystemContext, eventName: string, ...args: unknown[]) {
    (ctx.gm as any).emit(eventName, ...args);
  }

  private fetchRetry = fetchRetry.default(global.fetch);
}
