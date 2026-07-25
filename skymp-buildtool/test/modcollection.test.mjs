import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createModCollectionLock,
  hashTree,
  readPluginMasters,
} from "../src/modcollection.mjs";

function plugin(...masters) {
  const records = masters.map((master) => {
    const value = Buffer.from(`${master}\0`, "utf8");
    const header = Buffer.alloc(6);
    header.write("MAST", 0, "ascii");
    header.writeUInt16LE(value.length, 4);
    return Buffer.concat([header, value]);
  });
  const body = Buffer.concat(records);
  const header = Buffer.alloc(24);
  header.write("TES4", 0, "ascii");
  header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "skymp-modcollection-"));
  const staging = join(root, "staging");
  const mod = join(staging, "Example");
  const assets = join(staging, "Interface");
  const data = join(root, "Data");
  await mkdir(mod, { recursive: true });
  await mkdir(assets, { recursive: true });
  await mkdir(data, { recursive: true });
  const example = plugin("Skyrim.esm");
  await writeFile(join(mod, "Example.esp"), example);
  await writeFile(join(mod, "fomod-result.txt"), "chosen option");
  await writeFile(join(assets, "interface.swf"), "ui");
  await writeFile(join(data, "Skyrim.esm"), plugin());
  await writeFile(join(data, "Example.esp"), example);
  const exampleTree = await hashTree(mod);
  const assetTree = await hashTree(assets);
  const collectionExport = join(root, "collection-export.json");
  await writeFile(
    collectionExport,
    JSON.stringify({
      schemaVersion: 1,
      collection: {
        game: "skyrimspecialedition",
        slug: "example-collection",
        revision: 7,
      },
      mods: [
        {
          name: "Example",
          version: "1.2.3",
          modId: 42,
          fileId: 84,
          path: "Example",
          installOrder: 0,
          fomod: { selected: ["chosen option"] },
          plugins: ["Example.esp"],
          treeSha256: exampleTree.sha256,
          files: exampleTree.files,
        },
        {
          name: "Interface",
          version: "2.0.0",
          modId: 10,
          fileId: 20,
          path: "Interface",
          installOrder: 1,
          fomod: null,
          plugins: [],
          treeSha256: assetTree.sha256,
          files: assetTree.files,
        },
      ],
      loadOrder: ["Skyrim.esm", "Example.esp"],
    }),
  );
  return { root, staging, data, collectionExport };
}

test("publisher creates deterministic server/client locks and only required masters", async () => {
  const value = await fixture();
  try {
    const first = join(value.root, "first.json");
    const second = join(value.root, "second.json");
    const one = await createModCollectionLock({
      collectionExport: value.collectionExport,
      stagingDirectory: value.staging,
      dataDirectory: value.data,
      outputFile: first,
    });
    const two = await createModCollectionLock({
      collectionExport: value.collectionExport,
      stagingDirectory: value.staging,
      dataDirectory: value.data,
      outputFile: second,
    });
    assert.equal(await readFile(first, "utf8"), await readFile(second, "utf8"));
    assert.deepEqual(one.lock.server.loadOrder, ["Skyrim.esm", "Example.esp"]);
    assert.equal(one.lock.client.manifest.mods.length, 2);
    assert.deepEqual(one.lock.client.manifest.mods[1].plugins, []);
    assert.equal(one.lock.client.manifest.mods[0].key, "nexus:42:84");
    assert.equal(one.lock.collection.revision, 7);
    assert.deepEqual(two.lock, one.lock);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("publisher reads TES4 masters and blocks changed or foreign server plugins", async () => {
  const value = await fixture();
  try {
    assert.deepEqual(
      await readPluginMasters(join(value.data, "Example.esp")),
      ["Skyrim.esm"],
    );
    await writeFile(join(value.data, "Example.esp"), plugin("Update.esm"));
    await assert.rejects(
      createModCollectionLock({
        collectionExport: value.collectionExport,
        stagingDirectory: value.staging,
        dataDirectory: value.data,
        outputFile: join(value.root, "changed.json"),
      }),
      /differs from the pinned Collection/,
    );
    await writeFile(join(value.data, "Example.esp"), plugin("Skyrim.esm"));
    await writeFile(join(value.data, "Foreign.esp"), plugin("Skyrim.esm"));
    await assert.rejects(
      createModCollectionLock({
        collectionExport: value.collectionExport,
        stagingDirectory: value.staging,
        dataDirectory: value.data,
        outputFile: join(value.root, "foreign.json"),
      }),
      /not produced by the pinned Collection/,
    );
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("publisher blocks missing masters and non-official masterless server plugins", async () => {
  const value = await fixture();
  try {
    await rm(join(value.data, "Skyrim.esm"));
    await assert.rejects(
      createModCollectionLock({
        collectionExport: value.collectionExport,
        stagingDirectory: value.staging,
        dataDirectory: value.data,
        outputFile: join(value.root, "missing-master.json"),
      }),
      /requires missing master Skyrim\.esm/,
    );

    const masterless = plugin();
    const modRoot = join(value.staging, "Example");
    await writeFile(join(modRoot, "Example.esp"), masterless);
    await writeFile(join(value.data, "Example.esp"), masterless);
    const exported = JSON.parse(await readFile(value.collectionExport, "utf8"));
    const tree = await hashTree(modRoot);
    exported.mods[0].treeSha256 = tree.sha256;
    exported.mods[0].files = tree.files;
    await writeFile(value.collectionExport, JSON.stringify(exported));
    await assert.rejects(
      createModCollectionLock({
        collectionExport: value.collectionExport,
        stagingDirectory: value.staging,
        dataDirectory: value.data,
        outputFile: join(value.root, "masterless.json"),
      }),
      /has no master dependency/,
    );
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});
