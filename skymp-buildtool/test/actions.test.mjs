import assert from "node:assert/strict";
import test from "node:test";
import { previewClean } from "../src/actions.mjs";

test("clean preview is restricted to known scopes and explicit paths", () => {
  const build = previewClean("build");
  assert.equal(build.length, 1);
  assert.match(build[0], /[\\/]build$/u);
  const node = previewClean("node");
  assert.ok(node.length > 3);
  assert.ok(node.every((path) => path.includes("node_modules")));
  assert.throws(() => previewClean("repository"), /must be/u);
});
