export function clientPackMatches(expected, actual) {
  if (!expected) return true;
  if (!actual || typeof actual !== "object") return false;
  return actual.version === expected.version
    && actual.manifestSha256 === expected.manifestSha256;
}
