import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { loadConfiguration, saveLocalConfig } from "./config.mjs";
import { listCmakeTargets } from "./cmake.mjs";
import {
  buildAction,
  cleanAction,
  configureAction,
  doctorAction,
  gamemodeAction,
  packageAction,
  previewClean,
  runAction,
  setupAction,
  testAction,
} from "./actions.mjs";

const ESC = "\u001b";
const colors = {
  cyan: `${ESC}[36m`,
  green: `${ESC}[32m`,
  yellow: `${ESC}[33m`,
  red: `${ESC}[31m`,
  dim: `${ESC}[2m`,
  reset: `${ESC}[0m`,
};

export function menuIndexForKey(current, key, length) {
  if (key === "up") return (current - 1 + length) % length;
  if (key === "down") return (current + 1) % length;
  return current;
}

export function parseKey(data) {
  const key = data.toString();
  if (key === "\u0003") return "ctrl-c";
  if (key === "\r" || key === "\n") return "enter";
  if (key === `${ESC}[A`) return "up";
  if (key === `${ESC}[B`) return "down";
  if (key === ESC) return "escape";
  return key;
}

export async function startTui() {
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new Error("The interactive UI requires a TTY; use a CLI subcommand instead");
  }
  const terminal = new TerminalSession();
  terminal.enter();
  try {
    let running = true;
    while (running) {
      const configuration = await loadConfiguration();
      const action = await selectMenu(terminal, configuration, [
        { id: "doctor", label: "Environment doctor" },
        { id: "profile", label: "Select active profile" },
        { id: "configure", label: "Configure project" },
        { id: "build", label: "Build active profile" },
        { id: "build-test", label: "Build and run all tests" },
        { id: "target", label: "Expert: build a CMake target" },
        { id: "tests", label: "Run a test suite" },
        { id: "package", label: "Package managed server" },
        { id: "setup-managed", label: "Set up managed server" },
        { id: "gamemode", label: "Build/check/watch a gamemode" },
        { id: "run-server", label: "Run direct server" },
        { id: "run-managed", label: "Run managed server" },
        { id: "clean", label: "Clean build data" },
        { id: "exit", label: "Exit" },
      ]);
      if (!action || action.id === "exit") {
        running = false;
        continue;
      }
      await dispatchTuiAction(terminal, configuration, action.id);
    }
  } finally {
    terminal.leave();
  }
}

async function dispatchTuiAction(terminal, configuration, action) {
  if (action === "profile") {
    const profiles = Object.entries(configuration.definitions.profiles)
      .map(([id, profile]) => ({ id, label: `${id} — ${profile.description}` }));
    const selected = await selectMenu(terminal, configuration, profiles, "Select profile");
    if (selected) {
      await saveLocalConfig({ ...configuration.local, defaultProfile: selected.id });
    }
    return;
  }
  if (action === "target") {
    const targets = await listCmakeTargets();
    if (!targets.length) {
      await showMessage(terminal, "No targets available. Configure the project first.");
      return;
    }
    const selected = await selectMenu(
      terminal,
      configuration,
      targets.map((target) => ({ id: target, label: target })),
      "Select CMake target",
    );
    if (selected) await runWithLogView(terminal, `Build ${selected.id}`, (processOptions) =>
      buildAction(configuration, { targets: [selected.id], processOptions }));
    return;
  }
  if (action === "tests") {
    const selected = await selectMenu(terminal, configuration, [
      { id: "all", label: "All CTest suites" },
      { id: "unit", label: "C++ unit tests" },
      { id: "backend", label: "Managed backend" },
      { id: "server", label: "Server TypeScript" },
      { id: "gamemode-compiler", label: "Gamemode compiler" },
      { id: "buildtool", label: "Buildtool" },
    ], "Select test suite");
    if (selected) await runWithLogView(terminal, `Tests: ${selected.id}`, (processOptions) =>
      testAction(configuration, { suite: selected.id, processOptions }));
    return;
  }
  if (action === "gamemode") {
    const selected = await selectMenu(terminal, configuration, [
      { id: "build", label: "Build" },
      { id: "check", label: "Type-check" },
      { id: "watch", label: "Watch" },
    ], "Gamemode action");
    if (!selected) return;
    const configPath = await promptLine(terminal, "Path to gamemode.config.json: ");
    if (configPath) await runWithLogView(terminal, `Gamemode ${selected.id}`, (processOptions) =>
      gamemodeAction(configuration, selected.id, configPath, { processOptions }));
    return;
  }
  if (action === "clean") {
    const selected = await selectMenu(terminal, configuration, [
      { id: "build", label: "CMake build directory" },
      { id: "node", label: "Known node_modules directories" },
      { id: "vcpkg", label: "vcpkg generated files" },
      { id: "all", label: "All build data" },
    ], "Clean scope");
    if (!selected) return;
    const paths = previewClean(selected.id);
    const confirmation = await promptLine(
      terminal,
      `Delete:\n${paths.map((path) => `  ${path}`).join("\n")}\nType '${selected.id}' to confirm: `,
    );
    if (confirmation === selected.id) {
      await runWithLogView(terminal, `Clean ${selected.id}`, async (processOptions) => {
        await cleanAction(selected.id, { yes: true, processOptions });
      });
    }
    return;
  }
  if (action === "setup-managed") {
    await runInForeground(terminal, "Set up managed server", (processOptions) =>
      setupAction("managed-server", { processOptions }));
    return;
  }

  const handlers = {
    doctor: (processOptions) => doctorAction(configuration, {
      print: false,
      onOutput: processOptions.onOutput,
    }),
    configure: (processOptions) => configureAction(configuration, { processOptions }),
    build: (processOptions) => buildAction(configuration, { processOptions }),
    "build-test": (processOptions) => buildAction(configuration, { test: true, processOptions }),
    package: (processOptions) => packageAction(configuration, "managed-server", { processOptions }),
    "run-server": (processOptions) => runAction("server", { processOptions }),
    "run-managed": (processOptions) => runAction("managed-server", { processOptions }),
  };
  await runWithLogView(terminal, action, handlers[action]);
}

async function selectMenu(terminal, configuration, entries, title = "SkyMP Buildtool") {
  let index = 0;
  let active = true;
  const render = () => {
    const width = Math.max(40, stdout.columns ?? 80);
    const lines = [
      `${colors.cyan}${title}${colors.reset}`,
      `${colors.dim}${"─".repeat(Math.min(width - 1, 72))}${colors.reset}`,
      `Profile: ${colors.green}${configuration.profileName}${colors.reset}`,
      `Configuration: ${configuration.profile.configuration}`,
      `Skyrim: ${configuration.skyrimDir ?? "not configured"}`,
      "",
      ...entries.map((entry, position) =>
        `${position === index ? `${colors.cyan}>` : " "} ${entry.label}${colors.reset}`),
      "",
      `${colors.dim}↑/↓ select  Enter confirm  Esc back${colors.reset}`,
    ];
    terminal.render(lines);
  };
  const resize = () => render();
  stdout.on("resize", resize);
  try {
    render();
    while (active) {
      const key = await terminal.readKey();
      if (key === "ctrl-c") throw new Error("Interrupted");
      if (key === "escape") return undefined;
      if (key === "enter") return entries[index];
      index = menuIndexForKey(index, key, entries.length);
      render();
    }
  } finally {
    stdout.removeListener("resize", resize);
  }
}

async function runWithLogView(terminal, title, operation) {
  const lines = [];
  let pending = "";
  const onOutput = (chunk) => {
    pending += chunk;
    const split = pending.split(/\r?\n/u);
    pending = split.pop() ?? "";
    lines.push(...split);
    if (lines.length > 18) lines.splice(0, lines.length - 18);
    terminal.render([
      `${colors.cyan}${title}${colors.reset}`,
      `${colors.yellow}Running… Ctrl+C requests cancellation.${colors.reset}`,
      "",
      ...lines,
    ]);
  };
  terminal.setRaw(false);
  try {
    await operation({ display: false, onOutput });
    onOutput(`\n${colors.green}Completed successfully.${colors.reset}\n`);
  } catch (error) {
    onOutput(`\n${colors.red}${formatActionError(error)}${colors.reset}\n`);
  } finally {
    terminal.setRaw(true);
  }
  await showMessage(terminal, [...lines, "", "Press any key to continue."].join("\n"), false);
}

async function runInForeground(terminal, title, operation) {
  terminal.leave();
  // TerminalSession keeps stdin flowing for menu key presses. Pause the parent
  // stream so an interactive child with inherited stdin receives the input.
  stdin.pause();
  stdout.write(`\n${colors.cyan}${title}${colors.reset}\n\n`);
  try {
    await operation({ display: true, inheritStdio: true });
    stdout.write(`\n${colors.green}Completed successfully.${colors.reset}\n`);
  } catch (error) {
    stdout.write(`\n${colors.red}${formatActionError(error)}${colors.reset}\n`);
  }
  const readline = createInterface({ input: stdin, output: stdout });
  try {
    await readline.question("\nPress Enter to return to the buildtool.");
  } finally {
    readline.close();
    terminal.enter();
  }
}

async function showMessage(terminal, message, renderTitle = true) {
  terminal.render([
    ...(renderTitle ? [`${colors.cyan}SkyMP Buildtool${colors.reset}`, ""] : []),
    ...String(message).split("\n"),
  ]);
  await terminal.readKey();
}

async function promptLine(terminal, prompt) {
  terminal.leave();
  const readline = createInterface({ input: stdin, output: stdout });
  try {
    return (await readline.question(prompt)).trim();
  } finally {
    readline.close();
    terminal.enter();
  }
}

function formatActionError(error) {
  const recent = (error.diagnosticOutput?.length
    ? error.diagnosticOutput
    : error.recentOutput?.slice(-8))?.join("\n");
  return [
    error.message,
    recent,
    error.logPath ? `Full log: ${error.logPath}` : undefined,
  ].filter(Boolean).join("\n");
}

class TerminalSession {
  entered = false;

  enter() {
    if (this.entered) return;
    stdout.write(`${ESC}[?1049h${ESC}[?25l`);
    this.setRaw(true);
    stdin.resume();
    this.entered = true;
  }

  leave() {
    if (!this.entered) return;
    this.setRaw(false);
    stdout.write(`${ESC}[?25h${ESC}[?1049l`);
    this.entered = false;
  }

  setRaw(enabled) {
    if (stdin.isTTY) stdin.setRawMode(enabled);
  }

  render(lines) {
    stdout.write(`${ESC}[2J${ESC}[H${lines.join("\n")}`);
  }

  async readKey() {
    return await new Promise((resolvePromise) => {
      stdin.once("data", (data) => resolvePromise(parseKey(data)));
    });
  }
}
