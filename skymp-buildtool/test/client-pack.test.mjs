import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { packageClientPack } from "../src/client-pack.mjs";

test("client-pack packaging is reproducible and rejects files outside allowed areas", async () => {
  const root = await mkdtemp(join(tmpdir(), "skymp-packager-"));
  const staging = join(root, "staging");
  await mkdir(join(staging, "Platform", "Plugins"), { recursive: true });
  await mkdir(join(staging, "Platform", "UI"), { recursive: true });
  await writeFile(join(staging, "client-pack.json"), JSON.stringify({
    schemaVersion: 1,
    version: "2026.07.24",
    clientApiVersion: 1,
    entrypoint: "Platform/Plugins/skymp-server-extension.js",
    ui: "Platform/UI/index.html",
  }));
  await writeFile(join(staging, "Platform", "Plugins", "skymp-server-extension.js"), "extension");
  await writeFile(join(staging, "Platform", "UI", "index.html"), "<!doctype html>");
  const first = join(root, "first.zip");
  const second = join(root, "second.zip");
  await packageClientPack(staging, first);
  await packageClientPack(staging, second);
  assert.equal(await digest(first), await digest(second));

  await writeFile(join(staging, "forbidden.dll"), "no");
  await assert.rejects(() => packageClientPack(staging, join(root, "bad.zip")), /outside the allowed Platform areas/u);
  await rm(root, { recursive: true, force: true });
});

async function digest(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}
