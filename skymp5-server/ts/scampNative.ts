const scampNativeNode = require(process.cwd() + "/scam_native.node");

import type { MpMethods } from "../../skymp5-gamemode-compiler/types";

export type { Bot } from "../../skymp5-gamemode-compiler/types";

export interface ScampServer extends MpMethods {
  _setSelf(self: ScampServer): void;
  attachSaveStorage(): void;
  tick(): void;
}

export const createScampServer = (serverSettings: Record<string, unknown>) => {
  const res = new scampNativeNode.ScampServer(JSON.stringify(serverSettings)) as ScampServer;
  res._setSelf(res);
  return res;
}

export const getScampNative = () => {
  return scampNativeNode;
}
