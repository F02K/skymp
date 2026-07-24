import assert from "node:assert/strict";
import test from "node:test";
import {
  runCapture,
  runLogged,
  selectDiagnosticOutput,
} from "../src/process.mjs";

test("captures a child process without a shell", async () => {
  const result = await runCapture(process.execPath, ["-e", "process.stdout.write('hello')"]);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "hello");
});

test("logs success and reports failing process output", async () => {
  const success = await runLogged(process.execPath, ["-e", "console.log('ok')"], {
    label: "process-test-success",
    display: false,
  });
  assert.equal(success.code, 0);
  assert.match(success.logPath, /process-test-success\.log$/u);

  await assert.rejects(
    runLogged(process.execPath, ["-e", "console.error('expected failure'); process.exit(7)"], {
      label: "process-test-failure",
      display: false,
    }),
    (error) => error.exitCode === 7
      && error.recentOutput.some((line) => line.includes("expected failure")),
  );
});

test("reports a missing executable", async () => {
  const result = await runCapture("definitely-not-a-real-skymp-command", []);
  assert.equal(result.code, null);
  assert.match(result.error.message, /ENOENT/u);
});

test("keeps the actual error when successful output follows it", async () => {
  await assert.rejects(
    runLogged(process.execPath, [
      "-e",
      "console.error('thing.cpp : error LNK2001: missing symbol'); for (let i = 0; i < 50; i++) console.log(`target-${i} built`); process.exit(1)",
    ], {
      label: "process-test-early-error",
      display: false,
    }),
    (error) => error.diagnosticOutput.some((line) => line.includes("LNK2001")),
  );
});

test("diagnostic summary keeps the beginning and end of long error output", () => {
  const lines = Array.from({ length: 20 }, (_, index) => `file-${index}: error LNK2001`);
  const summary = selectDiagnosticOutput(lines, 8);
  assert.equal(summary.length, 8);
  assert.match(summary[0], /file-0/u);
  assert.match(summary.at(-1), /file-19/u);
  assert.ok(summary.some((line) => line.includes("weitere Fehlerzeilen")));
});
