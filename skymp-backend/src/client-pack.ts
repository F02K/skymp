import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import type {
  BackendConfig,
  ClientPackDescriptor,
  ClientPackManifest,
  ClientPackManifestFile,
} from './types.js';
import {
  signWithDirectoryIdentity,
  type StoredDirectoryIdentity,
} from './directory-protocol.js';
import { canonicalJson } from './canonical-json.js';

const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_FILES = 10_000;
const MAX_FILE_BYTES = 256 * 1024 * 1024;
const ENTRYPOINT = 'Platform/Plugins/skymp-server-extension.js' as const;

interface PackMetadata {
  schemaVersion: 1;
  version: string;
  clientApiVersion: 1;
  entrypoint: typeof ENTRYPOINT;
  ui?: string;
}

interface ZipEntry {
  name: string;
  method: number;
  crc32: number;
  compressedSize: number;
  size: number;
  localOffset: number;
  externalAttributes: number;
  directory: boolean;
}

export class ClientPackService {
  readonly archivePath: string;
  readonly archiveSize: number;
  readonly archiveSha256: string;
  private readonly metadata: PackMetadata;
  private readonly files: ClientPackManifestFile[];
  private readonly identity: StoredDirectoryIdentity;
  private manifestValue?: ClientPackManifest;
  private manifestRaw?: Buffer;
  private descriptorValue?: ClientPackDescriptor;

  constructor(
    readonly config: NonNullable<BackendConfig['server']['clientPack']>,
    identity: StoredDirectoryIdentity,
    serverId?: string,
  ) {
    this.identity = identity;
    this.archivePath = config.archive;
    const details = statSync(this.archivePath);
    if (!details.isFile()) throw new Error(`Client Pack archive is not a file: ${this.archivePath}`);
    if (details.size < 1 || details.size > MAX_ARCHIVE_BYTES) {
      throw new Error(`Client Pack archive size must be between 1 byte and ${MAX_ARCHIVE_BYTES} bytes`);
    }
    this.archiveSize = details.size;
    const archive = readFileSync(this.archivePath);
    this.archiveSha256 = sha256(archive);
    const parsed = validateArchive(archive);
    this.metadata = parsed.metadata;
    this.files = parsed.files;
    if (serverId) this.finalize(serverId);
  }

  finalize(serverId: string): void {
    if (this.manifestValue) {
      if (this.manifestValue.serverId !== serverId) {
        throw new Error('Client Pack cannot be rebound to a different server ID');
      }
      return;
    }
    const payload = {
      schemaVersion: 1 as const,
      serverId,
      version: this.metadata.version,
      clientApiVersion: 1 as const,
      permission: 'full-skyrim-platform' as const,
      entrypoint: ENTRYPOINT,
      ...(this.metadata.ui ? { ui: this.metadata.ui } : {}),
      archive: {
        format: 'zip' as const,
        size: this.archiveSize,
        sha256: this.archiveSha256,
      },
      files: this.files,
    };
    const signature = signWithDirectoryIdentity(this.identity, canonicalJson(payload));
    this.manifestValue = {
      ...payload,
      signature: { algorithm: 'Ed25519', value: signature },
    };
    this.manifestRaw = Buffer.from(canonicalJson(this.manifestValue));
    this.descriptorValue = {
      port: this.config.port,
      version: payload.version,
      clientApiVersion: 1,
      manifestSha256: sha256(this.manifestRaw),
    };
  }

  manifest(): ClientPackManifest {
    if (!this.manifestValue) throw new Error('Client Pack is waiting for a Directory server ID');
    return this.manifestValue;
  }

  manifestBytes(): Buffer {
    if (!this.manifestRaw) throw new Error('Client Pack is waiting for a Directory server ID');
    return this.manifestRaw;
  }

  descriptor(): ClientPackDescriptor | undefined {
    return this.descriptorValue;
  }
}

function validateArchive(archive: Buffer): { metadata: PackMetadata; files: ClientPackManifestFile[] } {
  const entries = readZipEntries(archive);
  if (entries.length > MAX_FILES + 1) throw new Error(`Client Pack contains more than ${MAX_FILES} files`);
  const names = new Set<string>();
  let totalSize = 0;
  let metadata: PackMetadata | undefined;
  const files: ClientPackManifestFile[] = [];
  for (const entry of entries) {
    const path = safePackPath(entry.directory ? entry.name.slice(0, -1) : entry.name);
    if (isSymlink(entry)) throw new Error(`Client Pack contains a symbolic link: ${path}`);
    if (entry.directory) continue;
    const key = path.toLowerCase();
    if (names.has(key)) throw new Error(`Client Pack contains a duplicate path: ${path}`);
    names.add(key);
    if (entry.size > MAX_FILE_BYTES) throw new Error(`Client Pack file is too large: ${path}`);
    totalSize += entry.size;
    if (totalSize > MAX_UNCOMPRESSED_BYTES) throw new Error('Client Pack expands beyond the allowed size');
    const content = extractEntry(archive, entry);
    if (path === 'client-pack.json') {
      metadata = validateMetadata(content);
      continue;
    }
    validateInstallPath(path);
    files.push({ path, size: content.length, sha256: sha256(content) });
  }
  if (!metadata) throw new Error('Client Pack is missing client-pack.json');
  if (!names.has(ENTRYPOINT.toLowerCase())) throw new Error(`Client Pack is missing ${ENTRYPOINT}`);
  if (metadata.ui && !names.has(metadata.ui.toLowerCase())) {
    throw new Error(`Client Pack UI entry does not exist: ${metadata.ui}`);
  }
  files.sort((left, right) => left.path.localeCompare(right.path, 'en'));
  return { metadata, files };
}

function validateMetadata(content: Buffer): PackMetadata {
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(content.toString('utf8')) as Record<string, unknown>;
  } catch {
    throw new Error('client-pack.json is not valid JSON');
  }
  if (value.schemaVersion !== 1
    || typeof value.version !== 'string'
    || value.version.length < 1
    || value.version.length > 100
    || value.clientApiVersion !== 1
    || value.entrypoint !== ENTRYPOINT
    || (value.ui !== undefined && typeof value.ui !== 'string')) {
    throw new Error('client-pack.json does not match Client Pack schema version 1');
  }
  const allowed = new Set(['schemaVersion', 'version', 'clientApiVersion', 'entrypoint', 'ui']);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error('client-pack.json contains unsupported properties');
  }
  const ui = value.ui === undefined ? undefined : safePackPath(value.ui);
  if (ui && (ui !== 'Platform/UI/index.html' || !ui.startsWith('Platform/UI/'))) {
    throw new Error('Client Pack UI entry must be Platform/UI/index.html');
  }
  return {
    schemaVersion: 1,
    version: value.version,
    clientApiVersion: 1,
    entrypoint: ENTRYPOINT,
    ...(ui ? { ui } : {}),
  };
}

function safePackPath(value: string): string {
  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(value));
  } catch {
    throw new Error('Client Pack contains a non-UTF-8 path');
  }
  const normalized = decoded.replaceAll('\\', '/');
  if (!normalized
    || normalized.startsWith('/')
    || /^[A-Za-z]:/.test(normalized)
    || normalized.includes('\0')
    || normalized.includes(':')) {
    throw new Error(`Unsafe Client Pack path: ${value}`);
  }
  const parts = normalized.split('/');
  if (parts.some((part) =>
    !part
    || part === '.'
    || part === '..'
    || /[ .]$/.test(part)
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new Error(`Unsafe Client Pack path: ${value}`);
  }
  return parts.join('/');
}

function validateInstallPath(path: string): void {
  if (/\.(?:dll|pex|esp|esm|esl|bsa)$/i.test(path)) {
    throw new Error(`Client Pack contains a forbidden native or game-plugin file: ${path}`);
  }
  if (path === ENTRYPOINT) return;
  if (path.startsWith('Platform/UI/')
    || path.startsWith('Platform/Fonts/')
    || path.startsWith('Platform/ServerAssets/')) return;
  throw new Error(`Client Pack path is outside the allowed Platform areas: ${path}`);
}

function readZipEntries(archive: Buffer): ZipEntry[] {
  const minimum = Math.max(0, archive.length - 65_557);
  let eocd = -1;
  for (let offset = archive.length - 22; offset >= minimum; --offset) {
    if (archive.readUInt32LE(offset) === 0x06054b50) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw new Error('Client Pack is not a supported ZIP archive');
  const count = archive.readUInt16LE(eocd + 10);
  const centralSize = archive.readUInt32LE(eocd + 12);
  const centralOffset = archive.readUInt32LE(eocd + 16);
  if (count === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw new Error('ZIP64 Client Packs are not supported');
  }
  if (centralOffset + centralSize > eocd) throw new Error('Client Pack ZIP central directory is invalid');
  const entries: ZipEntry[] = [];
  let offset = centralOffset;
  for (let index = 0; index < count; ++index) {
    if (offset + 46 > archive.length || archive.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error('Client Pack ZIP central directory entry is invalid');
    }
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const end = offset + 46 + nameLength + extraLength + commentLength;
    if (end > archive.length) throw new Error('Client Pack ZIP entry exceeds archive bounds');
    const nameBytes = archive.subarray(offset + 46, offset + 46 + nameLength);
    let name: string;
    try {
      name = new TextDecoder('utf-8', { fatal: true }).decode(nameBytes);
    } catch {
      throw new Error('Client Pack ZIP path is not UTF-8');
    }
    entries.push({
      name,
      method: archive.readUInt16LE(offset + 10),
      crc32: archive.readUInt32LE(offset + 16),
      compressedSize: archive.readUInt32LE(offset + 20),
      size: archive.readUInt32LE(offset + 24),
      externalAttributes: archive.readUInt32LE(offset + 38),
      localOffset: archive.readUInt32LE(offset + 42),
      directory: name.endsWith('/'),
    });
    offset = end;
  }
  if (offset !== centralOffset + centralSize) throw new Error('Client Pack ZIP central directory size is inconsistent');
  return entries;
}

function extractEntry(archive: Buffer, entry: ZipEntry): Buffer {
  const offset = entry.localOffset;
  if (offset + 30 > archive.length || archive.readUInt32LE(offset) !== 0x04034b50) {
    throw new Error(`Client Pack ZIP local entry is invalid: ${entry.name}`);
  }
  const nameLength = archive.readUInt16LE(offset + 26);
  const extraLength = archive.readUInt16LE(offset + 28);
  const start = offset + 30 + nameLength + extraLength;
  const end = start + entry.compressedSize;
  if (end > archive.length) throw new Error(`Client Pack ZIP entry exceeds archive: ${entry.name}`);
  const compressed = archive.subarray(start, end);
  let content: Buffer;
  if (entry.method === 0) content = Buffer.from(compressed);
  else if (entry.method === 8) content = inflateRawSync(compressed, { maxOutputLength: entry.size });
  else throw new Error(`Client Pack uses unsupported ZIP compression method ${entry.method}`);
  if (content.length !== entry.size || crc32(content) !== entry.crc32) {
    throw new Error(`Client Pack ZIP entry checksum is invalid: ${entry.name}`);
  }
  return content;
}

function isSymlink(entry: ZipEntry): boolean {
  const unixMode = entry.externalAttributes >>> 16;
  return (unixMode & 0o170000) === 0o120000;
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function crc32(value: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of value) {
    crc ^= byte;
    for (let bit = 0; bit < 8; ++bit) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
