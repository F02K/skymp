import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
} from 'node:crypto';

export interface StoredDirectoryIdentity {
  privateKey: string;
  publicKey: string;
  serverId?: string;
  directoryPublicKey?: string;
  joinCode?: string;
}

export interface DirectoryChallenge {
  schemaVersion: 1;
  registrationId: string;
  challenge: string;
  directoryUrl: string;
}

export const sha256 = (value: string | Buffer) =>
  createHash('sha256').update(value).digest('base64url');

export const canonicalDirectoryRequest = (
  purpose: 'register' | 'heartbeat',
  method: string,
  path: string,
  timestamp: string,
  nonce: string,
  rawBody: string,
) => [
  `skymp-directory-${purpose}-v1`,
  method.toUpperCase(),
  path,
  timestamp,
  nonce,
  sha256(rawBody),
].join('\n');

export const canonicalDirectoryChallenge = (
  registrationId: string,
  challenge: string,
  directoryUrl: string,
) => [
  'skymp-directory-challenge-v1',
  registrationId,
  challenge,
  directoryUrl.replace(/\/$/, ''),
].join('\n');

export function createDirectoryIdentity(): StoredDirectoryIdentity {
  const privateKey = generateKeyPairSync('ed25519').privateKey;
  return {
    privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
    publicKey: createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).toString('base64'),
  };
}

export function validateStoredDirectoryIdentity(value: unknown): value is StoredDirectoryIdentity {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  if (typeof item.privateKey !== 'string' || typeof item.publicKey !== 'string') return false;
  try {
    const privateKey = createPrivateKey({
      key: Buffer.from(item.privateKey, 'base64'),
      format: 'der',
      type: 'pkcs8',
    });
    const publicKey = createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).toString('base64');
    return privateKey.asymmetricKeyType === 'ed25519' && publicKey === item.publicKey;
  } catch {
    return false;
  }
}

export function signWithDirectoryIdentity(
  identity: StoredDirectoryIdentity,
  canonical: string,
): string {
  const privateKey = createPrivateKey({
    key: Buffer.from(identity.privateKey, 'base64'),
    format: 'der',
    type: 'pkcs8',
  });
  return sign(null, Buffer.from(canonical), privateKey).toString('base64url');
}

export function verifyDirectoryChallenge(
  value: unknown,
  expectedDirectoryUrl: string,
  identity: StoredDirectoryIdentity,
): { publicKey: string; signature: string } {
  const item = value as Partial<DirectoryChallenge> | null;
  if (!item || item.schemaVersion !== 1 || typeof item.registrationId !== 'string'
    || typeof item.challenge !== 'string' || typeof item.directoryUrl !== 'string') {
    throw new Error('Directory verification challenge is malformed');
  }
  const expected = expectedDirectoryUrl.replace(/\/$/, '');
  if (item.directoryUrl.replace(/\/$/, '') !== expected) {
    throw new Error('Directory verification challenge came from an unexpected Directory');
  }
  return {
    publicKey: identity.publicKey,
    signature: signWithDirectoryIdentity(
      identity,
      canonicalDirectoryChallenge(item.registrationId, item.challenge, expected),
    ),
  };
}
