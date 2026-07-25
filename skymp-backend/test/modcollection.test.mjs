import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  canonicalJson,
  loadModCollectionLock,
  modpackSummary,
  validatePublicManifest,
} from '../dist/modcollection.js';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

test('server ModCollection validation succeeds only for exact Data files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skymp-backend-modcollection-'));
  try {
    const data = join(root, 'Data');
    await mkdir(data);
    const plugin = Buffer.from('exact server plugin');
    await writeFile(join(data, 'Example.esp'), plugin);
    const manifest = {
      schemaVersion: 1,
      collection: {
        game: 'skyrimspecialedition',
        slug: 'example',
        revision: 2,
      },
      mods: [{
        key: 'nexus:42:84',
        name: 'Example',
        version: '1.0.0',
        nexus: { modId: 42, fileId: 84 },
        installOrder: 0,
        treeSha256: 'a'.repeat(64),
        plugins: ['Example.esp'],
      }],
      plugins: [{
        name: 'Example.esp',
        sha256: sha256(plugin),
        masters: [],
      }],
      loadOrder: ['Example.esp'],
    };
    const lock = {
      schemaVersion: 1,
      collection: manifest.collection,
      server: {
        files: [{
          path: 'Example.esp',
          size: plugin.length,
          sha256: sha256(plugin),
        }],
        plugins: [{
          name: 'Example.esp',
          sha256: sha256(plugin),
          masters: [],
        }],
        loadOrder: ['Example.esp'],
      },
      client: {
        manifestSha256: sha256(canonicalJson(manifest)),
        manifest,
      },
    };
    const lockPath = join(root, 'skymp-modcollection.lock.json');
    await writeFile(lockPath, JSON.stringify(lock));
    const loaded = loadModCollectionLock(lockPath, data);
    assert.deepEqual(modpackSummary(loaded), {
      collection: manifest.collection,
      manifestSha256: lock.client.manifestSha256,
      modCount: 1,
    });

    await writeFile(join(data, 'Example.esp'), 'tampered');
    assert.throws(
      () => loadModCollectionLock(lockPath, data),
      /wrong size|wrong hash/,
    );
    await rm(join(data, 'Example.esp'));
    assert.throws(
      () => loadModCollectionLock(lockPath, data),
      /server file is missing/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('public manifest rejects redistribution and local-machine fields', () => {
  const manifest = {
    schemaVersion: 1,
    collection: {
      game: 'skyrimspecialedition',
      slug: 'example',
      revision: 2,
    },
    mods: [{
      key: 'nexus:42:84',
      name: 'Example',
      version: '1.0.0',
      nexus: { modId: 42, fileId: 84 },
      installOrder: 0,
      treeSha256: 'a'.repeat(64),
      plugins: [],
      downloadUrl: 'https://forbidden.invalid/archive',
    }],
    plugins: [],
    loadOrder: [],
  };
  assert.throws(
    () => validatePublicManifest(manifest),
    /forbidden field downloadUrl/,
  );
});
