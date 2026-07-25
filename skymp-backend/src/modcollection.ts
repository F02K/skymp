import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import type { ModCollectionLock, PublicModpackManifest } from './types.js';

export function loadModCollectionLock(path: string, dataDirectory: string): ModCollectionLock {
  const value = JSON.parse(readFileSync(path, 'utf8')) as ModCollectionLock;
  validateLock(value);
  const canonicalManifest = canonicalJson(value.client.manifest);
  const actualManifestHash = sha256(Buffer.from(canonicalManifest));
  if (actualManifestHash !== value.client.manifestSha256) {
    throw new Error('ModCollection public manifest hash is invalid');
  }
  for (const file of value.server.files) {
    const target = contained(dataDirectory, resolve(dataDirectory, file.path));
    let info;
    try {
      info = statSync(target);
    } catch {
      throw new Error(`ModCollection server file is missing: ${file.path}`);
    }
    if (!info.isFile() || info.size !== file.size) {
      throw new Error(`ModCollection server file has the wrong size: ${file.path}`);
    }
    if (sha256(readFileSync(target)) !== file.sha256) {
      throw new Error(`ModCollection server file has the wrong hash: ${file.path}`);
    }
  }
  return value;
}

export function modpackSummary(lock: ModCollectionLock) {
  return {
    collection: lock.collection,
    manifestSha256: lock.client.manifestSha256,
    modCount: lock.client.manifest.mods.length,
  };
}

function validateLock(value: ModCollectionLock): void {
  if (
    value?.schemaVersion !== 1
    || value.collection?.game !== 'skyrimspecialedition'
    || typeof value.collection.slug !== 'string'
    || !/^[a-z0-9-]{1,100}$/.test(value.collection.slug)
    || !Number.isInteger(value.collection.revision)
    || value.collection.revision < 1
    || !Array.isArray(value.server?.files)
    || !Array.isArray(value.server?.plugins)
    || !Array.isArray(value.server?.loadOrder)
    || value.client?.manifestSha256?.length !== 64
  ) throw new Error('ModCollection lock is invalid');
  validatePublicManifest(value.client.manifest);
  if (canonicalJson(value.collection) !== canonicalJson(value.client.manifest.collection)) {
    throw new Error('ModCollection lock and public manifest reference different Collections');
  }
  const names = new Set<string>();
  for (const file of value.server.files) {
    if (
      typeof file.path !== 'string'
      || basename(file.path) !== file.path
      || !/\.(esm|esp|esl)$/i.test(file.path)
      || !Number.isInteger(file.size)
      || file.size < 0
      || !/^[a-f0-9]{64}$/.test(file.sha256)
    ) throw new Error('ModCollection contains an invalid server file');
    const key = file.path.toLowerCase();
    if (names.has(key)) throw new Error(`ModCollection duplicates ${file.path}`);
    names.add(key);
  }
  if (
    value.server.loadOrder.length !== value.server.files.length
    || value.server.loadOrder.some((name) => !names.has(name.toLowerCase()))
  ) throw new Error('ModCollection server load order is incomplete');
  if (value.server.plugins.length !== value.server.files.length) {
    throw new Error('ModCollection server plugin metadata is incomplete');
  }
  const positions = new Map(
    value.server.loadOrder.map((name, index) => [name.toLowerCase(), index]),
  );
  const pluginNames = new Set<string>();
  for (const plugin of value.server.plugins) {
    const key = plugin.name?.toLowerCase();
    const file = value.server.files.find((candidate) => candidate.path.toLowerCase() === key);
    if (
      typeof plugin.name !== 'string'
      || !file
      || plugin.sha256 !== file.sha256
      || !Array.isArray(plugin.masters)
      || plugin.masters.some((master) => typeof master !== 'string' || !master)
      || pluginNames.has(key)
    ) throw new Error('ModCollection contains invalid server plugin metadata');
    pluginNames.add(key);
    for (const master of plugin.masters) {
      const masterPosition = positions.get(master.toLowerCase());
      const pluginPosition = positions.get(key);
      if (masterPosition === undefined || pluginPosition === undefined || masterPosition >= pluginPosition) {
        throw new Error(`ModCollection must load ${master} before ${plugin.name}`);
      }
    }
  }
}

export function validatePublicManifest(value: PublicModpackManifest): void {
  if (
    value?.schemaVersion !== 1
    || value.collection?.game !== 'skyrimspecialedition'
    || !Array.isArray(value.mods)
    || !Array.isArray(value.plugins)
    || !Array.isArray(value.loadOrder)
    || value.mods.length < 1
    || value.mods.length > 5000
  ) throw new Error('ModCollection public manifest is invalid');
  const keys = new Set<string>();
  const orders = new Set<number>();
  for (const mod of value.mods) {
    if (
      typeof mod.key !== 'string'
      || !/^nexus:\d+:\d+$/.test(mod.key)
      || typeof mod.name !== 'string'
      || !mod.name
      || typeof mod.version !== 'string'
      || !mod.version
      || !Number.isInteger(mod.nexus?.modId)
      || mod.nexus.modId < 1
      || !Number.isInteger(mod.nexus?.fileId)
      || mod.nexus.fileId < 1
      || !Number.isInteger(mod.installOrder)
      || mod.installOrder < 0
      || !/^[a-f0-9]{64}$/.test(mod.treeSha256)
      || !Array.isArray(mod.plugins)
      || mod.plugins.some((plugin) => typeof plugin !== 'string' || !/\.(esm|esp|esl)$/i.test(plugin))
    ) throw new Error('ModCollection public manifest contains an invalid mod');
    if (keys.has(mod.key)) throw new Error(`ModCollection duplicates ${mod.key}`);
    if (orders.has(mod.installOrder)) throw new Error(`ModCollection duplicates install order ${mod.installOrder}`);
    keys.add(mod.key);
    orders.add(mod.installOrder);
  }
  if ([...orders].sort((left, right) => left - right).some((order, index) => order !== index)) {
    throw new Error('ModCollection install order is not contiguous');
  }
  const pluginNames = new Set<string>();
  for (const plugin of value.plugins) {
    const key = plugin?.name?.toLowerCase();
    if (
      typeof plugin?.name !== 'string'
      || !/\.(esm|esp|esl)$/i.test(plugin.name)
      || !/^[a-f0-9]{64}$/.test(plugin.sha256)
      || !Array.isArray(plugin.masters)
      || plugin.masters.some((master) => typeof master !== 'string' || !master)
      || pluginNames.has(key)
    ) throw new Error('ModCollection public manifest contains invalid plugin metadata');
    pluginNames.add(key);
  }
  if (
    new Set(value.loadOrder.map((name) => String(name).toLowerCase())).size !== value.loadOrder.length
    || value.loadOrder.some((name) => typeof name !== 'string' || !/\.(esm|esp|esl)$/i.test(name))
  ) throw new Error('ModCollection public load order is invalid');
  const forbidden = /archive|downloadUrl|token|stagingRoot|installationPath/i;
  const inspect = (item: unknown): void => {
    if (Array.isArray(item)) return item.forEach(inspect);
    if (!item || typeof item !== 'object') return;
    for (const [key, child] of Object.entries(item)) {
      if (forbidden.test(key)) throw new Error(`ModCollection contains forbidden field ${key}`);
      inspect(child);
    }
  };
  inspect(value);
}

export function canonicalJson(value: unknown): string {
  const sort = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(sort);
    if (item && typeof item === 'object') {
      return Object.fromEntries(
        Object.keys(item as Record<string, unknown>)
          .sort()
          .map((key) => [key, sort((item as Record<string, unknown>)[key])]),
      );
    }
    return item;
  };
  return JSON.stringify(sort(value));
}

function contained(root: string, target: string): string {
  const base = resolve(root);
  const candidate = resolve(target);
  if (candidate !== base && !candidate.startsWith(`${base}\\`) && !candidate.startsWith(`${base}/`)) {
    throw new Error('ModCollection server path escapes the Data directory');
  }
  return candidate;
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}
