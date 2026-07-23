import { System, Log } from "./system";
import Axios from "axios";
import { SystemContext } from "./system";

export class MasterApiBalanceSystem implements System {
    systemName = "MasterApiBalanceSystem";
      
    constructor(
        private log: Log,
        private maxPlayers: number,
        private backendUrl: string,
        private serverPort: number,
        private serverId: string,
        private backendToken: string,
        private offlineMode: boolean) { 
            this.sessionByUserId = new Array<string | undefined>(this.maxPlayers);
        }

    async initAsync(ctx: SystemContext): Promise<void> {
        const listenerFn = (userId: number, session: string) => {
            console.log(`MasterApiBalanceSystem.userAssignSession - Assigning session for userId ${userId}`);
            this.sessionByUserId[userId] = session;
        };
        ctx.gm.on("userAssignSession", listenerFn);

        this.log(`MasterApiBalanceSystem uses managed backend server ${this.serverId}`);

        // Effectively makes mp.getUserMasterApiBalance & mp.makeUserMasterApiPurchase a part of gamemode API
        (ctx.svr as any).getUserMasterApiBalance = async (userId: number): Promise<number> => {
            if (this.offlineMode) {
                console.log("MasterApiBalanceSystem.getUserMasterApiBalance - Always zero balance in offline mode");
                return 0;
            }

            const session = this.sessionByUserId[userId];
            if (!session) {
                console.error(`MasterApiBalanceSystem.getUserMasterApiBalance - Invalid session value for userId ${userId} (session = ${session})`);
                throw new Error(`MasterApiBalanceSystem.getUserMasterApiBalance - Invalid session value for userId ${userId} (session = ${session})`);
            }
            return await this.getUserBalanceImpl(session);
        };

        (ctx.svr as any).makeUserMasterApiPurchase = async (userId: number, balanceToSpend: number): Promise<{ balanceSpent: number, success: boolean }> => {
            if (this.offlineMode) {
                console.log("MasterApiBalanceSystem.makeUserMasterApiPurchase - Purchase impossible in offline mode");
                return { balanceSpent: 0, success: false };
            }
            const session = this.sessionByUserId[userId];
            if (!session) {
                console.error(`MasterApiBalanceSystem.makeUserMasterApiPurchase - Invalid session value for userId ${userId} (session = ${session})`);
                throw new Error(`MasterApiBalanceSystem.makeUserMasterApiPurchase - Invalid session value for userId ${userId} (session = ${session})`);
            }
            return await this.makeUserMasterApiPurchaseImpl(session, balanceToSpend);
        };
    }

    private async getUserBalanceImpl(session: string): Promise<number> {
        try {
            const response = await Axios.get(
                `${this.backendUrl}/api/internal/servers/${encodeURIComponent(this.serverId)}/sessions/${encodeURIComponent(session)}/balance`,
                { headers: { Authorization: `Bearer ${this.backendToken}` } },
            );
            if (!response.data || !response.data.user || !response.data.user.id || typeof response.data.user.balance !== "number") {
                throw new Error(`getUserBalanceImpl: bad master-api response ${JSON.stringify(response.data)}`);
            }
            return response.data.user.balance as number;
        } catch (error) {
            throw error;
        }
    }

    private async makeUserMasterApiPurchaseImpl(session: string, balanceToSpend: number): Promise<{ balanceSpent: number, success: boolean }> {
        try {
            const response = await Axios.post(
                `${this.backendUrl}/api/internal/servers/${encodeURIComponent(this.serverId)}/sessions/${encodeURIComponent(session)}/purchases`,
                { balanceToSpend },
                { headers: { Authorization: `Bearer ${this.backendToken}` } }
            );
            if (!response.data || typeof response.data.balanceSpent !== "number" || typeof response.data.success !== "boolean") {
                throw new Error(`makeUserMasterApiPurchaseImpl: bad master-api response ${JSON.stringify(response.data)}`);
            }
            return response.data;
        } catch (error) {
            throw error;
        }
    }

    connect(userId: number, ctx: SystemContext) {
        console.log(`MasterApiBalanceSystem.connect - Cleaning session for userId ${userId}`);
        this.sessionByUserId[userId] = undefined;
    }

    disconnect(userId: number, ctx: SystemContext) {
        console.log(`MasterApiBalanceSystem.disconnect - Cleaning session for userId ${userId}`);
        this.sessionByUserId[userId] = undefined;
    }

    private sessionByUserId: Array<string | undefined>;
}
