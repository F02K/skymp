import assert from "node:assert/strict";
import { createPublicKey, createHash, verify } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { packageClientPack } from "../../skymp-buildtool/src/client-pack.mjs";
import { startApis, stopServer } from "../dist/api.js";
import { canonicalJson } from "../dist/canonical-json.js";
import { ClientPackService } from "../dist/client-pack.js";
import { createDirectoryIdentity } from "../dist/directory-protocol.js";
import { createLogger } from "../dist/logger.js";
import { RuntimeState } from "../dist/runtime-state.js";
import { SqliteStorage } from "../dist/storage.js";

test("Client Pack manifest is identity-signed and public archive supports HEAD and one range", async () => {
  const root = await mkdtemp(join(tmpdir(), "skymp-client-pack-"));
  const staging = join(root, "staging");
  await mkdir(join(staging, "Platform", "Plugins"), { recursive: true });
  await writeFile(join(staging, "client-pack.json"), JSON.stringify({
    schemaVersion: 1,
    version: "1.2.3",
    clientApiVersion: 1,
    entrypoint: "Platform/Plugins/skymp-server-extension.js",
  }));
  await writeFile(join(staging, "Platform", "Plugins", "skymp-server-extension.js"), "extension");
  const archive = join(root, "pack.zip");
  await packageClientPack(staging, archive);
  const identity = createDirectoryIdentity();
  const clientPack = new ClientPackService({ archive, host: "127.0.0.1", port: 0 }, identity, "server-one");
  const manifest = clientPack.manifest();
  const { signature, ...payload } = manifest;
  const publicKey = createPublicKey({
    key: Buffer.from(identity.publicKey, "base64"),
    format: "der",
    type: "spki",
  });
  assert.equal(
    verify(null, Buffer.from(canonicalJson(payload)), publicKey, Buffer.from(signature.value, "base64url")),
    true,
  );
  assert.equal(
    createHash("sha256").update(clientPack.manifestBytes()).digest("hex"),
    clientPack.descriptor().manifestSha256,
  );

  const item = {
    internalApi: { host: "127.0.0.1", port: 0 },
    database: { adapter: "sqlite", path: join(root, "backend.sqlite") },
    server: {
      id: "server-one", internalTokenEnv: "TOKEN", name: "Test", description: "", region: "test",
      tags: [], gamePort: 7777, resourcesPort: 7778, gamemode: "default", dataDirectory: "./data",
      plugins: [], loadOrder: [], maxPlayers: 10, visibility: "private",
      clientPack: clientPack.config,
    },
    supervisor: {
      command: process.execPath, args: [], cwd: root, readyTimeoutMs: 1000, shutdownTimeoutMs: 1000,
      restart: { enabled: false, initialDelayMs: 1, maxDelayMs: 1, maxAttempts: 1, windowMs: 1 },
    },
    sessions: { ttlSeconds: 60 }, modules: [],
  };
  const storage = new SqliteStorage(item.database.path);
  await storage.migrate();
  const apis = await startApis({
    config: item,
    storage,
    state: new RuntimeState(10),
    logger: createLogger({ test: true }),
    internalToken: "token",
    clientPack,
  });
  const port = apis.clientPackServer.address().port;
  const base = `http://127.0.0.1:${port}/api/client-pack`;
  const manifestResponse = await fetch(`${base}/manifest`);
  assert.equal(manifestResponse.status, 200);
  assert.equal(await manifestResponse.text(), clientPack.manifestBytes().toString());
  const notModified = await fetch(`${base}/manifest`, {
    headers: { 'if-none-match': manifestResponse.headers.get('etag') },
  });
  assert.equal(notModified.status, 304);
  const head = await fetch(`${base}/archive`, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(Number(head.headers.get("content-length")), clientPack.archiveSize);
  const range = await fetch(`${base}/archive`, { headers: { range: "bytes=1-3" } });
  assert.equal(range.status, 206);
  assert.equal((await range.arrayBuffer()).byteLength, 3);
  const multiRange = await fetch(`${base}/archive`, { headers: { range: "bytes=0-1,4-5" } });
  assert.equal(multiRange.status, 416);
  assert.equal((await fetch(`${base}/../internal/servers/server-one/heartbeat`)).status, 404);

  await stopServer(apis.clientPackServer);
  await stopServer(apis.internalServer);
  await storage.close();
  await rm(root, { recursive: true, force: true });
});
