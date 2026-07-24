export interface RemoteAuthGameData {
  session: string;
  profileId?: number;
  discordUsername: string | null;
  discordDiscriminator: string | null;
  discordAvatar: string | null;
};

export interface LocalAuthGameData {
  profileId: number;
};

export interface AuthGameData {
  remote?: RemoteAuthGameData;
  local?: LocalAuthGameData;
};

export const authGameDataStorageKey = "authGameData";
