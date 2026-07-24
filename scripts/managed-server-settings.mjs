export function portableManagedServerSettings(source) {
  const settings = structuredClone(source);
  delete settings.backend;
  delete settings.master;
  delete settings.masterKey;
  settings.offlineMode = false;
  settings.dataDir = './data';
  settings.gamemodePath = './gamemode.js';
  settings.loadOrder = [];
  return settings;
}
