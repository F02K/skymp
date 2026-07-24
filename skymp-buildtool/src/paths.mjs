import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const toolRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const repositoryRoot = resolve(toolRoot, "..");
export const buildDirectory = resolve(repositoryRoot, "build");
export const localConfigPath = resolve(repositoryRoot, ".skymp-buildtool.json");
export const profilesPath = resolve(toolRoot, "profiles.json");
export const statePath = resolve(buildDirectory, ".skymp-buildtool-state.json");
export const logDirectory = resolve(buildDirectory, "logs", "skymp-buildtool");

export const nodeModuleDirectories = [
  "skymp-backend/node_modules",
  "skymp5-client/node_modules",
  "skymp5-front/node_modules",
  "skymp5-gamemode-compiler/node_modules",
  "skymp5-gamemode-compiler/examples/template-plugin/node_modules",
  "skymp5-server/node_modules",
  "skyrim-platform/node_modules",
  "skyrim-platform/tools/dev_service/node_modules",
  "misc/prettier/node_modules",
].map((path) => resolve(repositoryRoot, path));
