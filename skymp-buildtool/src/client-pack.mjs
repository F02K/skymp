import { createWriteStream } from "node:fs";
import { lstat, mkdir, readFile, readdir } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

const ENTRYPOINT = "Platform/Plugins/skymp-server-extension.js";
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_FILES = 10_000;

export async function packageClientPack(stagingDirectory, outputFile) {
  if (!stagingDirectory || !outputFile) {
    throw new Error("package client-pack requires <staging-directory> <output.zip>");
  }
  const root = resolve(stagingDirectory);
  const target = resolve(outputFile);
  if (target === root || target.startsWith(`${root}${sep}`)) {
    throw new Error("Client Pack output ZIP must be outside the staging directory");
  }
  const entries = await collectFiles(root);
  const metadataEntry = entries.find((entry) => entry.path === "client-pack.json");
  if (!metadataEntry) throw new Error("Client Pack staging is missing client-pack.json");
  validateMetadata(JSON.parse((await readFile(metadataEntry.absolute)).toString("utf8")), entries);
  await mkdir(dirname(target), { recursive: true });
  await writeZip(target, entries);
  return { outputFile: target, files: entries.length };
}

async function collectFiles(root) {
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory()) throw new Error(`Client Pack staging is not a directory: ${root}`);
  const entries = [];
  const keys = new Set();
  let total = 0;
  const visit = async (directory) => {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const child of children) {
      const absolute = resolve(directory, child.name);
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) throw new Error(`Client Pack cannot contain a symbolic link: ${absolute}`);
      if (info.isDirectory()) {
        await visit(absolute);
        continue;
      }
      if (!info.isFile()) throw new Error(`Client Pack contains an unsupported filesystem entry: ${absolute}`);
      const path = relative(root, absolute).split(sep).join("/");
      validatePath(path);
      const key = path.toLowerCase();
      if (keys.has(key)) throw new Error(`Client Pack contains a case-insensitive duplicate path: ${path}`);
      keys.add(key);
      total += info.size;
      if (total > MAX_UNCOMPRESSED_BYTES) throw new Error("Client Pack staging exceeds the expanded size limit");
      entries.push({ path, absolute, size: info.size });
      if (entries.length > MAX_FILES + 1) throw new Error(`Client Pack contains more than ${MAX_FILES} installable files`);
    }
  };
  await visit(root);
  return entries.sort((left, right) => left.path.localeCompare(right.path, "en"));
}

function validateMetadata(value, entries) {
  if (!value
    || value.schemaVersion !== 1
    || typeof value.version !== "string"
    || value.version.length < 1
    || value.version.length > 100
    || value.clientApiVersion !== 1
    || value.entrypoint !== ENTRYPOINT
    || (value.ui !== undefined && value.ui !== "Platform/UI/index.html")) {
    throw new Error("client-pack.json does not match Client Pack schema version 1");
  }
  const allowed = new Set(["schemaVersion", "version", "clientApiVersion", "entrypoint", "ui"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error("client-pack.json contains unsupported properties");
  }
  const names = new Set(entries.map((entry) => entry.path.toLowerCase()));
  if (!names.has(ENTRYPOINT.toLowerCase())) throw new Error(`Client Pack is missing ${ENTRYPOINT}`);
  if (value.ui && !names.has(value.ui.toLowerCase())) throw new Error(`Client Pack UI entry does not exist: ${value.ui}`);
}

function validatePath(path) {
  if (!path || path.startsWith("/") || /^[A-Za-z]:/u.test(path)
    || path.includes(":") || path.includes("\0")
    || path.split("/").some((part) =>
      !part
      || part === "."
      || part === ".."
      || /[ .]$/u.test(part)
      || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part))) {
    throw new Error(`Unsafe Client Pack path: ${path}`);
  }
  if (path === "client-pack.json" || path === ENTRYPOINT
    || path.startsWith("Platform/UI/")
    || path.startsWith("Platform/Fonts/")
    || path.startsWith("Platform/ServerAssets/")) {
    if (/\.(?:dll|pex|esp|esm|esl|bsa)$/iu.test(path)) {
      throw new Error(`Client Pack contains a forbidden native or game-plugin file: ${path}`);
    }
    return;
  }
  throw new Error(`Client Pack path is outside the allowed Platform areas: ${path}`);
}

async function writeZip(target, entries) {
  const fileRecords = [];
  let offset = 0;
  const estimatedSize = entries.reduce((total, entry) => {
    const nameBytes = Buffer.byteLength(entry.path, "utf8");
    return total + 30 + nameBytes + entry.size + 46 + nameBytes;
  }, 22);
  if (estimatedSize > MAX_ARCHIVE_BYTES) throw new Error("Client Pack archive exceeds the archive size limit");
  const output = createWriteStream(target, { flags: "w" });
  for (const entry of entries) {
    const content = await readFile(entry.absolute);
    const name = Buffer.from(entry.path, "utf8");
    const crc = crc32(content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x0021, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(content.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(name.length, 26);
    output.write(local);
    output.write(name);
    output.write(content);
    fileRecords.push({ name, crc, size: content.length, offset });
    offset += local.length + name.length + content.length;
  }
  const centralOffset = offset;
  for (const record of fileRecords) {
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x0021, 14);
    central.writeUInt32LE(record.crc, 16);
    central.writeUInt32LE(record.size, 20);
    central.writeUInt32LE(record.size, 24);
    central.writeUInt16LE(record.name.length, 28);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(record.offset, 42);
    output.write(central);
    output.write(record.name);
    offset += central.length + record.name.length;
  }
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(fileRecords.length, 8);
  eocd.writeUInt16LE(fileRecords.length, 10);
  eocd.writeUInt32LE(offset - centralOffset, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  output.write(eocd);
  await new Promise((resolvePromise, reject) => {
    output.once("error", reject);
    output.end(resolvePromise);
  });
}

function crc32(value) {
  let crc = 0xffffffff;
  for (const byte of value) {
    crc ^= byte;
    for (let bit = 0; bit < 8; ++bit) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
