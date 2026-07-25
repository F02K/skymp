import { createHash } from "node:crypto";
import {
  readFile,
  readdir,
  stat,
  writeFile,
  mkdir,
} from "node:fs/promises";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";

const PLUGIN_EXTENSIONS = new Set([".esm", ".esp", ".esl"]);
const OFFICIAL_MASTERS = new Set([
  "skyrim.esm",
  "update.esm",
  "dawnguard.esm",
  "hearthfires.esm",
  "dragonborn.esm",
]);

export async function createModCollectionLock({
  collectionExport,
  stagingDirectory,
  dataDirectory,
  outputFile,
  selectedPlugins,
}) {
  const input = validateExport(
    JSON.parse(await readFile(resolve(collectionExport), "utf8")),
  );
  const stagingRoot = resolve(stagingDirectory);
  const serverData = resolve(dataDirectory);
  const clientMods = [];
  const clientPlugins = new Map();

  for (const mod of input.mods) {
    const modRoot = contained(stagingRoot, resolve(stagingRoot, mod.path));
    const tree = await hashTree(modRoot);
    if (
      tree.sha256 !== mod.treeSha256
      || canonicalJson(tree.files) !== canonicalJson(mod.files)
    ) {
      throw new Error(
        `Collection staging for ${mod.name} changed after the Vortex export`,
      );
    }
    const plugins = [];
    for (const file of tree.files) {
      if (!isPlugin(file.path)) continue;
      const absolute = join(modRoot, ...file.path.split("/"));
      const masters = await readPluginMasters(absolute);
      const plugin = {
        name: basename(file.path),
        sha256: file.sha256,
        masters,
      };
      const key = plugin.name.toLowerCase();
      if (clientPlugins.has(key)) {
        throw new Error(`Collection produces duplicate plugin ${plugin.name}`);
      }
      clientPlugins.set(key, { ...plugin, modKey: modKey(mod) });
      plugins.push(plugin.name);
    }
    if (
      canonicalJson([...plugins].sort((left, right) => left.localeCompare(right, "en")))
      !== canonicalJson([...mod.plugins].map((name) => basename(name)).sort((left, right) => left.localeCompare(right, "en")))
    ) {
      throw new Error(`Collection plugin output changed for ${mod.name}`);
    }
    clientMods.push({
      key: modKey(mod),
      name: mod.name,
      version: mod.version,
      nexus: { modId: mod.modId, fileId: mod.fileId },
      installOrder: mod.installOrder,
      treeSha256: tree.sha256,
      plugins,
    });
  }

  const serverPlugins = await scanPluginDirectory(serverData);
  const selected = new Map();
  const requestedSelection = selectedPlugins?.length
    ? new Set(selectedPlugins.map((name) => name.toLowerCase()))
    : null;
  for (const plugin of serverPlugins.values()) {
    if (isOfficialMaster(plugin.name)) continue;
    const expected = clientPlugins.get(plugin.name.toLowerCase());
    if (!expected) {
      throw new Error(
        `Server plugin ${plugin.name} is not produced by the pinned Collection`,
      );
    }
    if (expected.sha256 !== plugin.sha256) {
      throw new Error(
        `Server plugin ${plugin.name} differs from the pinned Collection`,
      );
    }
    if (plugin.masters.length === 0) {
      throw new Error(`Server plugin ${plugin.name} has no master dependency`);
    }
    if (requestedSelection && !requestedSelection.has(plugin.name.toLowerCase())) {
      continue;
    }
    selected.set(plugin.name.toLowerCase(), plugin);
  }
  if (requestedSelection) {
    for (const name of requestedSelection) {
      if (!selected.has(name)) {
        throw new Error(`Selected server plugin ${name} is unavailable`);
      }
    }
  }

  const required = new Map(selected);
  const visit = (plugin) => {
    for (const masterName of plugin.masters) {
      const key = masterName.toLowerCase();
      const master = serverPlugins.get(key);
      if (!master) {
        throw new Error(`${plugin.name} requires missing master ${masterName}`);
      }
      if (!required.has(key)) {
        required.set(key, master);
        visit(master);
      }
    }
  };
  for (const plugin of selected.values()) visit(plugin);

  const requestedOrder = uniqueNames(input.loadOrder);
  const orderIndex = new Map(
    requestedOrder.map((name, index) => [name.toLowerCase(), index]),
  );
  const loadOrder = [...required.values()]
    .sort((left, right) => {
      const li = orderIndex.get(left.name.toLowerCase());
      const ri = orderIndex.get(right.name.toLowerCase());
      if (li !== undefined && ri !== undefined) return li - ri;
      if (li !== undefined) return -1;
      if (ri !== undefined) return 1;
      if (isOfficialMaster(left.name) !== isOfficialMaster(right.name)) {
        return isOfficialMaster(left.name) ? -1 : 1;
      }
      return left.name.localeCompare(right.name, "en");
    })
    .map((plugin) => plugin.name);
  validateLoadOrder(loadOrder, required);

  const publicManifest = {
    schemaVersion: 1,
    collection: {
      game: "skyrimspecialedition",
      slug: input.collection.slug,
      revision: input.collection.revision,
    },
    mods: clientMods,
    plugins: [...clientPlugins.values()].map(({ modKey: _modKey, ...plugin }) => plugin),
    loadOrder: requestedOrder,
  };
  const manifestSha256 = sha256(canonicalJson(publicManifest));
  const lock = {
    schemaVersion: 1,
    collection: publicManifest.collection,
    server: {
      files: loadOrder.map((name) => {
        const plugin = required.get(name.toLowerCase());
        return {
          path: plugin.name,
          size: plugin.size,
          sha256: plugin.sha256,
        };
      }),
      plugins: loadOrder.map((name) => {
        const plugin = required.get(name.toLowerCase());
        return {
          name: plugin.name,
          sha256: plugin.sha256,
          masters: plugin.masters,
        };
      }),
      loadOrder,
    },
    client: { manifestSha256, manifest: publicManifest },
  };

  const target = resolve(outputFile);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${canonicalJson(lock, 2)}\n`, "utf8");
  return { lock, outputFile: target };
}

export async function readPluginMasters(file) {
  const data = await readFile(file);
  if (data.length < 24 || data.toString("ascii", 0, 4) !== "TES4") {
    throw new Error(`${basename(file)} is not a valid Bethesda plugin`);
  }
  const recordSize = data.readUInt32LE(4);
  const end = Math.min(data.length, 24 + recordSize);
  const masters = [];
  let offset = 24;
  let extendedSize = null;
  while (offset + 6 <= end) {
    const type = data.toString("ascii", offset, offset + 4);
    let size = data.readUInt16LE(offset + 4);
    offset += 6;
    if (type === "XXXX") {
      if (size !== 4 || offset + 4 > end) break;
      extendedSize = data.readUInt32LE(offset);
      offset += 4;
      continue;
    }
    if (extendedSize !== null) {
      size = extendedSize;
      extendedSize = null;
    }
    if (offset + size > end) break;
    if (type === "MAST") {
      masters.push(
        data
          .subarray(offset, offset + size)
          .toString("utf8")
          .replace(/\0+$/u, ""),
      );
    }
    offset += size;
  }
  return uniqueNames(masters);
}

export async function hashTree(root) {
  const files = [];
  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Collection staging contains symbolic link ${absolute}`);
      }
      if (entry.isDirectory()) {
        await walk(absolute);
      } else if (entry.isFile()) {
        const info = await stat(absolute);
        const path = relative(root, absolute).replaceAll("\\", "/");
        files.push({
          path,
          size: info.size,
          sha256: sha256(await readFile(absolute)),
        });
      }
    }
  }
  await walk(root);
  const digest = files
    .map((file) => `${file.path}\0${file.size}\0${file.sha256}\n`)
    .join("");
  return { sha256: sha256(digest), files };
}

export function canonicalJson(value, spacing = 0) {
  const sort = (item) => {
    if (Array.isArray(item)) return item.map(sort);
    if (item && typeof item === "object") {
      return Object.fromEntries(
        Object.keys(item)
          .sort()
          .map((key) => [key, sort(item[key])]),
      );
    }
    return item;
  };
  return JSON.stringify(sort(value), null, spacing);
}

async function scanPluginDirectory(directory) {
  const result = new Map();
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !isPlugin(entry.name)) continue;
    const absolute = join(directory, entry.name);
    const info = await stat(absolute);
    const plugin = {
      name: entry.name,
      size: info.size,
      sha256: sha256(await readFile(absolute)),
      masters: await readPluginMasters(absolute),
    };
    const key = entry.name.toLowerCase();
    if (result.has(key)) throw new Error(`Duplicate server plugin ${entry.name}`);
    result.set(key, plugin);
  }
  return result;
}

function validateExport(value) {
  assertPortableExport(value);
  if (
    value?.schemaVersion !== 1 ||
    value?.collection?.game !== "skyrimspecialedition" ||
    typeof value.collection.slug !== "string" ||
    !/^[a-z0-9-]{1,100}$/u.test(value.collection.slug) ||
    !Number.isInteger(value.collection.revision) ||
    value.collection.revision < 1 ||
    !Array.isArray(value.mods) ||
    value.mods.length === 0 ||
    !Array.isArray(value.loadOrder)
  ) {
    throw new Error("Invalid SkyMP Vortex Collection export");
  }
  const seen = new Set();
  const orders = new Set();
  for (const mod of value.mods) {
    if (
      typeof mod.name !== "string" ||
      !mod.name ||
      typeof mod.version !== "string" ||
      !mod.version ||
      !Number.isInteger(mod.modId) ||
      mod.modId < 1 ||
      !Number.isInteger(mod.fileId) ||
      mod.fileId < 1 ||
      typeof mod.path !== "string" ||
      !mod.path ||
      !Number.isInteger(mod.installOrder) ||
      mod.installOrder < 0 ||
      !/^[a-f0-9]{64}$/u.test(mod.treeSha256) ||
      !Array.isArray(mod.files) ||
      !Array.isArray(mod.plugins) ||
      !("fomod" in mod)
    ) {
      throw new Error("Collection export contains an invalid mod");
    }
    for (const file of mod.files) {
      if (
        typeof file.path !== "string" ||
        !file.path ||
        resolve("/", file.path) === resolve(file.path) ||
        !Number.isInteger(file.size) ||
        file.size < 0 ||
        !/^[a-f0-9]{64}$/u.test(file.sha256)
      ) {
        throw new Error("Collection export contains invalid canonical file metadata");
      }
    }
    const key = modKey(mod);
    if (seen.has(key)) throw new Error(`Duplicate Collection file ${key}`);
    if (orders.has(mod.installOrder)) {
      throw new Error(`Duplicate Collection install order ${mod.installOrder}`);
    }
    seen.add(key);
    orders.add(mod.installOrder);
  }
  if (
    [...orders]
      .sort((left, right) => left - right)
      .some((order, index) => order !== index)
  ) {
    throw new Error("Collection install order must be contiguous");
  }
  value.mods.sort((left, right) => left.installOrder - right.installOrder);
  return value;
}

function assertPortableExport(value) {
  const forbidden = /token|archive|downloadUrl|stagingRoot|installationPath|absolutePath/iu;
  const inspect = (item) => {
    if (Array.isArray(item)) return item.forEach(inspect);
    if (typeof item === "string") {
      if (
        isAbsolute(item) ||
        /^[a-z]:[\\/]/iu.test(item) ||
        item.startsWith("\\\\")
      ) {
        throw new Error("Collection export contains an absolute path");
      }
      return;
    }
    if (!item || typeof item !== "object") return;
    for (const [key, child] of Object.entries(item)) {
      if (forbidden.test(key)) {
        throw new Error(`Collection export contains forbidden field ${key}`);
      }
      inspect(child);
    }
  };
  inspect(value);
}

function validateLoadOrder(loadOrder, plugins) {
  const positions = new Map(
    loadOrder.map((name, index) => [name.toLowerCase(), index]),
  );
  for (const plugin of plugins.values()) {
    const position = positions.get(plugin.name.toLowerCase());
    if (position === undefined) {
      throw new Error(`Load order omits required plugin ${plugin.name}`);
    }
    for (const master of plugin.masters) {
      const masterPosition = positions.get(master.toLowerCase());
      if (masterPosition === undefined || masterPosition >= position) {
        throw new Error(
          `Load order must place ${master} before ${plugin.name}`,
        );
      }
    }
  }
}

function uniqueNames(values) {
  const seen = new Set();
  const result = [];
  for (const raw of values) {
    const value = String(raw);
    const key = value.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      result.push(value);
    }
  }
  return result;
}

function isOfficialMaster(name) {
  const key = name.toLowerCase();
  return OFFICIAL_MASTERS.has(key) || /^cc[a-z0-9_-]+\.(esm|esl)$/u.test(key);
}

function isPlugin(name) {
  return PLUGIN_EXTENSIONS.has(extname(name).toLowerCase());
}

function modKey(mod) {
  return `nexus:${mod.modId}:${mod.fileId}`;
}

function contained(root, candidate) {
  const base = resolve(root);
  const target = resolve(candidate);
  if (target !== base && !target.startsWith(`${base}\\`) && !target.startsWith(`${base}/`)) {
    throw new Error("Collection mod path escapes the staging root");
  }
  return target;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
