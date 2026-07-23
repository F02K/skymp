import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const roots = [
  "skymp-backend/src",
  "skymp-backend/README.md",
  "skymp-backend/MIGRATION.md",
  "skymp-backend/backend.config.example.json",
  "skymp-backend/backend.config.schema.json",
  "skymp5-server/ts",
  "skymp5-client/src",
].map((value) => path.join(repositoryRoot, value));
const forbidden = [
  { label: "/api/v2", pattern: /\/api\/v2\b/ },
  { label: "/v1", pattern: /\/v1\b/ },
  { label: "/v2", pattern: /\/v2\b/ },
];
const clientForbidden = [
  { label: "client HTTP API route", pattern: /\/api\// },
  { label: "client HttpClient", pattern: /\bHttpClient\b/ },
  { label: "client backend resolver", pattern: /\bgetMasterUrl\b/ },
  { label: "client backend secret", pattern: /server-master-key/ },
];

function filesAt(value) {
  const stat = fs.statSync(value);
  if (stat.isFile()) return [value];
  return fs
    .readdirSync(value, { withFileTypes: true })
    .flatMap((entry) => filesAt(path.join(value, entry.name)));
}

const violations = roots.flatMap(filesAt).flatMap((file) => {
  const content = fs.readFileSync(file, "utf8");
  const patterns = file.includes(`${path.sep}skymp5-client${path.sep}`)
    ? [...forbidden, ...clientForbidden]
    : forbidden;
  return patterns
    .filter(({ pattern }) => pattern.test(content))
    .map(({ label }) => `${file}: contains forbidden HTTP route ${label}`);
});

if (violations.length) {
  console.error(violations.join("\n"));
  process.exitCode = 1;
} else {
  console.log("Active SkyMP sources use only the unversioned /api contract.");
}
