const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

const repoRoot = path.resolve(__dirname, "../..");
const declarationsPath = path.join(__dirname, "../types/index.d.ts");

function read(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function interfaceMembers(interfaceName) {
  const sourceFile = ts.createSourceFile(
    declarationsPath,
    read(declarationsPath),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const declaration = sourceFile.statements.find(
    (statement) =>
      ts.isInterfaceDeclaration(statement) && statement.name.text === interfaceName,
  );
  assert.ok(declaration, `Missing interface ${interfaceName}`);
  return new Set(
    declaration.members
      .map((member) => member.name)
      .filter(Boolean)
      .map((name) => {
        if (ts.isIdentifier(name) || ts.isStringLiteral(name)) {
          return name.text;
        }
        return name.getText(sourceFile);
      }),
  );
}

test("public methods match the native ScampServer registrations", () => {
  const nativeSource = read(
    path.join(repoRoot, "skymp5-server/cpp/addon/ScampServer.cpp"),
  );
  const registered = new Set(
    [...nativeSource.matchAll(/InstanceMethod\("([^"]+)"/g)].map((match) => match[1]),
  );
  const internal = new Set([
    "_setSelf",
    "attachSaveStorage",
    "tick",
    "_sp3ListClasses",
    "_sp3GetBaseClass",
    "_sp3ListStaticFunctions",
    "_sp3ListMethods",
    "_sp3GetFunctionImplementation",
    "_sp3DynamicCast",
  ]);
  const expected = new Set([...registered].filter((name) => !internal.has(name)));
  assert.deepEqual(interfaceMembers("MpMethods"), expected);
});

test("standard property types match the native property bindings", () => {
  const nativeSource = read(
    path.join(repoRoot, "skymp5-server/cpp/addon/property_bindings/PropertyBindingFactory.cpp"),
  );
  const registered = new Set(
    [...nativeSource.matchAll(/result\["([^"]+)"\]/g)].map((match) => match[1]),
  );
  assert.deepEqual(interfaceMembers("MpStandardPropertyMap"), registered);
});

test("built-in event types match the gamemode event implementations", () => {
  const eventsDirectory = path.join(
    repoRoot,
    "skymp5-server/cpp/server_guest_lib/gamemode_events",
  );
  const registered = new Set();
  for (const fileName of fs.readdirSync(eventsDirectory)) {
    if (!fileName.endsWith("Event.cpp")) {
      continue;
    }
    const source = read(path.join(eventsDirectory, fileName));
    for (const match of source.matchAll(/return "(on[A-Za-z]+)";/g)) {
      registered.add(match[1]);
    }
  }
  assert.deepEqual(interfaceMembers("MpBuiltinEvents"), registered);
});
