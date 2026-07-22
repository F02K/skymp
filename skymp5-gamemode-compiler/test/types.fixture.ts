import type { Appearance, MpEventHandler, MpMethods } from "../types";

declare module "../types" {
  interface MpCustomPropertyMap {
    reputation: number;
  }

  interface MpCustomEvents {
    onReputationChanged?: MpEventHandler<[formId: number, reputation: number]>;
  }
}

const api: MpMethods = mp;
const position = api.get(0xff000001, "pos");
const reputation = api.get(0xff000001, "reputation");
api.set(0xff000001, "reputation", reputation + position[0]);

mp.onActivate = (target, caster) => target !== caster;
mp.onReputationChanged = (_formId, nextReputation) => nextReputation >= 0;
mp["onPapyrusEvent:OnItemAdded"] = (_formId, item) => item !== null;

const appearance: Appearance | null = mp.get(0xff000001, "appearance");
void appearance;
