export type FormId = number;
export type UserId = number;
export type Vector3 = [number, number, number];

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface Tint {
  texturePath: string;
  argb: number;
  type: number;
}

export interface Appearance {
  isFemale: boolean;
  raceId: FormId;
  weight: number;
  skinColor: number;
  hairColor: number;
  headpartIds: FormId[];
  headTextureSetId: FormId;
  options: number[];
  presets: number[];
  tints: Tint[];
  name: string;
}

export interface InventoryEntry {
  baseId: FormId;
  count: number;
  health?: number | null;
  enchantmentId?: FormId | null;
  maxCharge?: number | null;
  removeEnchantmentOnUnequip?: boolean | null;
  chargePercent?: number | null;
  name?: string | null;
  soul?: number | null;
  poisonId?: FormId | null;
  poisonCount?: number | null;
  worn?: boolean | null;
  wornLeft?: boolean | null;
}

export interface Inventory {
  entries: InventoryEntry[];
}

export interface Equipment {
  inv: Inventory;
  leftSpell: FormId | null;
  rightSpell: FormId | null;
  voiceSpell: FormId | null;
  instantSpell: FormId | null;
  numChanges: number;
}

export interface LocationalData {
  cellOrWorldDesc: string;
  pos: Vector3;
  rot: Vector3;
}

export interface ActorValues {
  health: number;
  magicka: number;
  stamina: number;
}

export interface EspmField {
  type: string;
  data: Uint8Array;
}

export interface EspmRecord {
  id: number;
  editorId: string;
  type: string;
  flags: number;
  fields: EspmField[];
}

export interface EspmLookupResult {
  record?: EspmRecord;
  fileIndex?: number;
  toGlobalRecordId?(localRecordId: number): FormId;
}

export interface PacketHistoryElement {
  data: Uint8Array;
  timeMs: number;
}

export interface PacketHistory {
  packets: PacketHistoryElement[];
}

export interface PapyrusObject {
  type: "espm" | "form";
  desc: string;
}

export type PapyrusValue =
  | null
  | boolean
  | number
  | string
  | PapyrusObject
  | PapyrusValue[];

export type PapyrusCallType = "method" | "global";

export interface MakePropertyOptions {
  isVisibleByOwner: boolean;
  isVisibleByNeighbors: boolean;
  updateOwner: string;
  updateNeighbor: string;
}

export interface Bot {
  getUserId(): UserId;
  destroy(): void;
  send(message: JsonValue | Uint8Array): void;
}

export interface MpStandardPropertyMap {
  actorNeighbors: FormId[];
  angle: Vector3;
  appearance: Appearance | null;
  baseDesc: string;
  equipment: Equipment;
  inventory: Inventory;
  isDead: boolean;
  isDisabled: boolean;
  isOnline: boolean;
  isOpen: boolean;
  locationalData: LocationalData;
  neighbors: FormId[];
  onlinePlayers: FormId[];
  percentages: ActorValues;
  pos: Vector3;
  profileId: number | undefined;
  spawnPoint: LocationalData;
  type: "MpActor" | "MpObjectReference";
  worldOrCellDesc: string;
  idx: number;
  consoleCommandsAllowed: boolean;
  spawnDelay: number;
  templateChain: FormId[] | undefined;
  lastAnimEvent: string | null | undefined;
  respawnPercentages: ActorValues;
}

/** Augment this interface in a gamemode to type custom properties. */
export interface MpCustomPropertyMap {}

export type MpPropertyMap = MpStandardPropertyMap & MpCustomPropertyMap;

export interface MpWritablePropertyMap {
  appearance: Appearance | null;
  inventory: Inventory | null;
  isDead: boolean;
  isDisabled: boolean;
  isOpen: boolean;
  locationalData: LocationalData;
  percentages: ActorValues;
  profileId: number;
  spawnPoint: LocationalData;
  consoleCommandsAllowed: boolean;
  spawnDelay: number;
  respawnPercentages: ActorValues;
}

export interface MpMethods {
  on(event: "connect", handler: (userId: UserId) => void): void;
  on(event: "disconnect", handler: (userId: UserId) => void): void;
  on(event: "customPacket", handler: (userId: UserId, content: string) => void): void;

  createActor(
    baseFormId: FormId,
    pos: number[],
    angleZ: number,
    cellOrWorld: FormId,
    userProfileId?: number,
  ): FormId;
  destroyActor(formId: FormId): void;
  setUserActor(userId: UserId, actorFormId: FormId): void;
  getUserActor(userId: UserId): FormId;
  getUserGuid(userId: UserId): string;
  isConnected(userId: UserId): boolean;
  getActorName(actorId: FormId): string;
  getActorPos(actorId: FormId): Vector3;
  getActorCellOrWorld(actorId: FormId): FormId;
  setRaceMenuOpen(formId: FormId, open: boolean): void;
  sendCustomPacket(userId: UserId, jsonContent: string): void;
  setEnabled(formId: FormId, enabled: boolean): void;
  getActorsByProfileId(profileId: number): FormId[];
  createBot(): Bot;
  getUserByActor(formId: FormId): UserId;
  getUserIp(userId: UserId): string;
  kick(userId: UserId): void;

  getLocalizedString(globalRecordId: FormId, language?: string): string | undefined;
  getServerSettings<T extends Record<string, unknown> = Record<string, unknown>>(): Readonly<T>;
  clear(): void;
  makeProperty(propertyName: string, options: MakePropertyOptions): void;
  makeEventSource(eventName: string, functionBody: string): void;
  get<K extends keyof MpPropertyMap>(formId: FormId, propertyName: K): MpPropertyMap[K];
  get<T = unknown>(formId: FormId, propertyName: string): T | undefined;
  set<K extends keyof MpWritablePropertyMap>(
    formId: FormId,
    propertyName: K,
    value: MpWritablePropertyMap[K],
  ): void;
  set<T>(formId: FormId, propertyName: string, value: T): void;
  place(globalRecordId: FormId): FormId;
  lookupEspmRecordById(globalRecordId: FormId): EspmLookupResult;
  getEspmLoadOrder(): string[];
  getNeighborsByPosition(cellOrWorldDesc: string, pos: Vector3): FormId[];
  getAllForms(modIndex: number): Uint32Array;
  getDescFromId(formId: FormId): string;
  getIdFromDesc(formDesc: string): FormId;
  callPapyrusFunction(
    callType: PapyrusCallType,
    className: string,
    functionName: string,
    self: PapyrusValue,
    args: PapyrusValue[],
  ): PapyrusValue;
  registerPapyrusFunction(
    callType: PapyrusCallType,
    className: string,
    functionName: string,
    handler: (self: PapyrusValue, args: PapyrusValue[]) => PapyrusValue,
  ): void;
  setPacketHistoryRecording(userId: UserId, isRecording: boolean): void;
  getPacketHistory(userId: UserId): PacketHistory;
  clearPacketHistory(userId: UserId): void;
  requestPacketHistoryPlayback(userId: UserId, packetHistory: PacketHistory): void;
  findFormsByPropertyValue(propertyName: string, propertyValue: JsonValue): FormId[];
  getPrometheusMetrics(): string;
}

export type MpEventHandler<Args extends unknown[]> = (...args: Args) => boolean | void;

export interface MpBuiltinEvents {
  onActivate?: MpEventHandler<[refrId: FormId, casterRefrId: FormId]>;
  onCraft?: MpEventHandler<[
    actorId: FormId,
    craftedItemBaseId: FormId,
    count: number,
    recipeId: FormId,
  ]>;
  onDeath?: MpEventHandler<[actorId: FormId, killerId: FormId]>;
  onDropItem?: MpEventHandler<[actorId: FormId, baseId: FormId, count: number]>;
  onEatItem?: MpEventHandler<[actorId: FormId, baseId: FormId]>;
  onPutItem?: MpEventHandler<[
    sourceRefrId: FormId,
    actorId: FormId,
    baseId: FormId,
    count: number,
  ]>;
  onReadBook?: MpEventHandler<[actorId: FormId, baseId: FormId]>;
  onRespawn?: MpEventHandler<[actorId: FormId]>;
  onTakeItem?: MpEventHandler<[
    sourceRefrId: FormId,
    actorId: FormId,
    baseId: FormId,
    count: number,
  ]>;
  onUpdateAppearanceAttempt?: MpEventHandler<[
    actorId: FormId,
    appearance: Appearance,
    isAllowed: boolean,
  ]>;
  onUpdateEquipmentAttempt?: MpEventHandler<[
    actorId: FormId,
    equipment: Equipment,
    isAllowed: boolean,
  ]>;
}

/** Augment this interface in a gamemode to type custom event handlers. */
export interface MpCustomEvents {}

export type MpPapyrusEvents = {
  [eventName in `onPapyrusEvent:${string}`]?: MpEventHandler<
    [formId: FormId, ...args: PapyrusValue[]]
  >;
};

export type Mp = MpMethods & MpBuiltinEvents & Partial<MpCustomEvents> & MpPapyrusEvents;

declare global {
  const mp: Mp;
}
