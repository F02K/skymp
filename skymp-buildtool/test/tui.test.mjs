import assert from "node:assert/strict";
import test from "node:test";
import { menuIndexForKey, parseKey } from "../src/tui.mjs";

test("menu navigation wraps in both directions", () => {
  assert.equal(menuIndexForKey(0, "up", 4), 3);
  assert.equal(menuIndexForKey(3, "down", 4), 0);
  assert.equal(menuIndexForKey(2, "other", 4), 2);
});

test("parses terminal navigation and control keys", () => {
  assert.equal(parseKey(Buffer.from("\u001b[A")), "up");
  assert.equal(parseKey(Buffer.from("\u001b[B")), "down");
  assert.equal(parseKey(Buffer.from("\r")), "enter");
  assert.equal(parseKey(Buffer.from("\u001b")), "escape");
  assert.equal(parseKey(Buffer.from("\u0003")), "ctrl-c");
});
