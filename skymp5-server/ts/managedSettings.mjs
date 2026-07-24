/**
 * Applies environment values supplied by the managed backend to the complete
 * server settings object. The returned object is a clone; callers can safely
 * retain the source for diagnostics.
 *
 * @param {Record<string, unknown>} source
 * @param {Record<string, string | undefined>} environment
 * @returns {{ managed: boolean, settings: Record<string, unknown> }}
 */
export function applyManagedServerEnvironment(source, environment = process.env) {
  const settings = structuredClone(source);
  const backendValues = [
    environment.SKYMP_BACKEND_URL,
    environment.SKYMP_BACKEND_SERVER_ID,
    environment.SKYMP_BACKEND_TOKEN_ENV,
  ];
  const managed = backendValues.some(Boolean);
  if (managed) {
    if (!backendValues.every(Boolean)) {
      throw new Error(
        'Managed backend overrides require SKYMP_BACKEND_URL, '
        + 'SKYMP_BACKEND_SERVER_ID and SKYMP_BACKEND_TOKEN_ENV together',
      );
    }
    settings.backend = {
      url: environment.SKYMP_BACKEND_URL,
      serverId: environment.SKYMP_BACKEND_SERVER_ID,
      tokenEnv: environment.SKYMP_BACKEND_TOKEN_ENV,
    };
    settings.offlineMode = false;
    delete settings.master;
    delete settings.masterKey;
  }

  if (environment.SKYMP_SERVER_NAME) settings.name = environment.SKYMP_SERVER_NAME;
  if (environment.SKYMP_SERVER_MAX_PLAYERS) {
    settings.maxPlayers = positiveInteger(
      environment.SKYMP_SERVER_MAX_PLAYERS,
      'SKYMP_SERVER_MAX_PLAYERS',
    );
  }
  if (environment.SKYMP_SERVER_PORT) {
    const port = positiveInteger(environment.SKYMP_SERVER_PORT, 'SKYMP_SERVER_PORT');
    if (port > 65535) throw new Error('SKYMP_SERVER_PORT must be a valid port');
    settings.port = port;
  }
  if (environment.SKYMP_GAMEMODE_PATH) {
    settings.gamemodePath = environment.SKYMP_GAMEMODE_PATH;
  }
  if (environment.SKYMP_DATA_DIRECTORY) {
    settings.dataDir = environment.SKYMP_DATA_DIRECTORY;
  }
  if (environment.SKYMP_LOAD_ORDER) {
    const loadOrder = JSON.parse(environment.SKYMP_LOAD_ORDER);
    if (!Array.isArray(loadOrder) || !loadOrder.every((item) => typeof item === 'string')) {
      throw new Error('SKYMP_LOAD_ORDER must be a JSON string array');
    }
    settings.loadOrder = loadOrder;
  }
  const clientPackValues = [
    environment.SKYMP_CLIENT_PACK_VERSION,
    environment.SKYMP_CLIENT_PACK_MANIFEST_SHA256,
  ];
  if (clientPackValues.some(Boolean)) {
    if (!clientPackValues.every(Boolean)) {
      throw new Error(
        'SKYMP_CLIENT_PACK_VERSION and SKYMP_CLIENT_PACK_MANIFEST_SHA256 must be supplied together',
      );
    }
    if (!/^[a-f0-9]{64}$/.test(environment.SKYMP_CLIENT_PACK_MANIFEST_SHA256)) {
      throw new Error('SKYMP_CLIENT_PACK_MANIFEST_SHA256 must be a lowercase SHA-256 hex digest');
    }
    settings.clientPack = {
      version: environment.SKYMP_CLIENT_PACK_VERSION,
      manifestSha256: environment.SKYMP_CLIENT_PACK_MANIFEST_SHA256,
      clientApiVersion: 1,
    };
  }

  return { managed, settings };
}

function positiveInteger(value, field) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${field} must be a positive integer`);
  }
  return parsed;
}
