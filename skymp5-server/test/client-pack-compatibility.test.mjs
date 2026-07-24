import assert from 'node:assert/strict';
import test from 'node:test';
import { clientPackMatches } from '../ts/clientPackCompatibility.mjs';

const expected = { version: '1.2.3', manifestSha256: 'a'.repeat(64), clientApiVersion: 1 };

test('Core-only login accepts no receipt while Pack servers require exact version and manifest hash', () => {
  assert.equal(clientPackMatches(null, null), true);
  assert.equal(clientPackMatches(null, { version: 'old', manifestSha256: 'b'.repeat(64) }), true);
  assert.equal(clientPackMatches(expected, null), false);
  assert.equal(clientPackMatches(expected, { version: '1.2.2', manifestSha256: expected.manifestSha256 }), false);
  assert.equal(clientPackMatches(expected, { version: expected.version, manifestSha256: 'b'.repeat(64) }), false);
  assert.equal(clientPackMatches(expected, {
    version: expected.version,
    manifestSha256: expected.manifestSha256,
  }), true);
});
