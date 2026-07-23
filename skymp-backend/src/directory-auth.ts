import { createPublicKey, verify } from 'node:crypto';
import type { BackendConfig } from './types.js';

export interface DirectoryGrant {
  schemaVersion: 1;
  jti: string;
  audience: string;
  issuedAt: number;
  expiresAt: number;
  identity: { discordId: string; username: string; avatar?: string };
  membership?: { guildId: string; roles: string[] };
}

export class GrantError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
};
export const canonicalPlayGrant = (grant: DirectoryGrant) => `skymp-play-grant-v1\n${canonicalJson(grant)}`;

export function verifyDirectoryGrant(body: unknown, config: BackendConfig): DirectoryGrant {
  const value = body as Record<string, unknown> | null;
  const grant = value?.grant as DirectoryGrant | undefined;
  const signature = typeof value?.signature === 'string' ? value.signature : '';
  if (!grant || grant.schemaVersion !== 1 || !grant.jti || !grant.identity?.discordId || !grant.identity?.username || !signature) throw new GrantError(400, 'invalidPlayGrant', 'Play grant is malformed.');
  if (!config.sessions.directoryPublicKey) throw new GrantError(503, 'directoryAuthUnavailable', 'Directory public key is not configured.');
  let valid = false;
  try {
    const key = createPublicKey({ key: Buffer.from(config.sessions.directoryPublicKey, 'base64'), format: 'der', type: 'spki' });
    valid = verify(null, Buffer.from(canonicalPlayGrant(grant)), key, Buffer.from(signature, 'base64url'));
  } catch { valid = false; }
  if (!valid) throw new GrantError(401, 'invalidPlayGrantSignature', 'Play grant signature is invalid.');
  if (grant.audience !== config.server.id) throw new GrantError(403, 'playGrantAudienceMismatch', 'Play grant belongs to another server.');
  const now = Date.now(); const skew = config.sessions.clockSkewMs ?? 30000;
  if (!Number.isFinite(grant.issuedAt) || !Number.isFinite(grant.expiresAt) || grant.expiresAt - grant.issuedAt > 60000 || grant.issuedAt > now + skew || grant.expiresAt < now - skew) throw new GrantError(401, 'playGrantExpired', 'Play grant is expired or not yet valid.');
  if (grant.membership && (!grant.membership.guildId || !Array.isArray(grant.membership.roles))) throw new GrantError(400, 'invalidPlayGrant', 'Play grant membership is malformed.');
  const requiredGuild = config.server.access?.discordGuild;
  if (requiredGuild?.required && grant.membership?.guildId !== requiredGuild.guildId) throw new GrantError(403, 'guildMembershipRequired', 'Required Discord guild membership is missing.');
  return grant;
}
