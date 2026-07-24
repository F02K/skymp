import assert from "node:assert/strict";
import test from "node:test";
import {
  inspectVcpkgCompilerLog,
  versionAtLeast,
} from "../src/doctor.mjs";

test("compares semantic tool versions", () => {
  assert.equal(versionAtLeast("22.0.0", "22.0.0"), true);
  assert.equal(versionAtLeast("v22.10.1", "22.0.0"), true);
  assert.equal(versionAtLeast("21.99.0", "22.0.0"), false);
  assert.equal(versionAtLeast("4.3.1", "3.19.0"), true);
});

test("detects vcpkg dependencies built with an incompatible newer Visual Studio", () => {
  const incompatible = inspectVcpkgCompilerLog(
    "Compiler found: C:/Program Files/Microsoft Visual Studio/18/Community/VC/Tools/MSVC/14.51/cl.exe\n",
  );
  assert.equal(incompatible.status, "error");
  assert.match(incompatible.detail, /Visual Studio 2026/u);

  const compatible = inspectVcpkgCompilerLog(
    "Compiler found: C:/Program Files/Microsoft Visual Studio/2022/Professional/VC/Tools/MSVC/14.44/cl.exe\n",
  );
  assert.equal(compatible.status, "ok");

  const mixedHostAndTarget = inspectVcpkgCompilerLog([
    "Detecting compiler hash for triplet x64-windows...",
    "Compiler found: C:/Program Files/Microsoft Visual Studio/18/Community/VC/Tools/MSVC/14.51/cl.exe",
    "Detecting compiler hash for triplet x64-windows-sp...",
    "Compiler found: C:/Program Files/Microsoft Visual Studio/2022/Professional/VC/Tools/MSVC/14.44/cl.exe",
  ].join("\n"));
  assert.equal(mixedHostAndTarget.status, "ok");
});
