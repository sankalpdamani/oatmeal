// One-click MCP integrations: write the Oatmeal MCP server into the config of
// each AI coding tool the user has installed (Claude Code, Claude Desktop,
// Codex CLI, GitHub Copilot in VS Code, Copilot CLI).
//
// The MCP server is bundled with the app (resources/mcp/index.js) and runs via
// Oatmeal's own binary with ELECTRON_RUN_AS_NODE — no Node.js install needed.
// Transcripts never leave the machine: the tool spawns the server locally over
// stdio and reads the local SQLite database.
import { app, shell } from "electron";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { upsertCodexToml, type McpLaunch } from "./mcp-config";

export type IntegrationId =
  | "claude-code"
  | "claude-desktop"
  | "codex"
  | "copilot-vscode"
  | "copilot-cli";

export interface IntegrationStatus {
  id: IntegrationId;
  label: string;
  installed: boolean; // the tool itself appears to be present
  connected: boolean; // an "oatmeal" MCP entry exists in its config
  stale: boolean; // entry exists but points at a script that is gone
  detail: string | null; // human-readable summary of the configured entry
  cliCommand: string | null; // paste-ready terminal command, for CLI tools
  openable: boolean; // GUI tool Oatmeal can launch after connecting
  configPath: string;
}

// How a client should launch the bundled MCP server.
export function mcpLaunch(): McpLaunch {
  const script = app.isPackaged
    ? path.join(process.resourcesPath, "mcp", "index.js")
    : path.join(app.getAppPath(), "resources", "mcp", "index.js");
  return {
    command: process.execPath,
    args: ["--no-warnings", script],
    env: { ELECTRON_RUN_AS_NODE: "1" },
  };
}

const HOME = os.homedir();

const paths = {
  claudeCode: path.join(HOME, ".claude.json"),
  claudeDesktop: path.join(
    HOME,
    "Library",
    "Application Support",
    "Claude",
    "claude_desktop_config.json"
  ),
  codexDir: path.join(HOME, ".codex"),
  codexConfig: path.join(HOME, ".codex", "config.toml"),
  vscodeUserDir: path.join(HOME, "Library", "Application Support", "Code", "User"),
  vscodeMcp: path.join(HOME, "Library", "Application Support", "Code", "User", "mcp.json"),
  copilotCliDir: path.join(HOME, ".copilot"),
  copilotCliConfig: path.join(HOME, ".copilot", "mcp-config.json"),
};

function readJson(file: string): Record<string, any> | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(file: string, obj: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".oatmeal-tmp";
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, file);
}

// --- per-tool connect ---
// Each writes an entry named "oatmeal" into the tool's own MCP config format.

function connectClaudeCode(launch: McpLaunch) {
  // User-scope MCP servers live at the top level of ~/.claude.json — the same
  // place `claude mcp add --scope user` writes. Preserve everything else.
  const cfg = readJson(paths.claudeCode) ?? {};
  cfg.mcpServers = {
    ...(cfg.mcpServers ?? {}),
    oatmeal: { type: "stdio", command: launch.command, args: launch.args, env: launch.env },
  };
  writeJson(paths.claudeCode, cfg);
}

function connectClaudeDesktop(launch: McpLaunch) {
  const cfg = readJson(paths.claudeDesktop) ?? {};
  cfg.mcpServers = {
    ...(cfg.mcpServers ?? {}),
    oatmeal: { command: launch.command, args: launch.args, env: launch.env },
  };
  writeJson(paths.claudeDesktop, cfg);
}

function connectCodex(launch: McpLaunch) {
  const existing = fs.existsSync(paths.codexConfig)
    ? fs.readFileSync(paths.codexConfig, "utf8")
    : "";
  fs.mkdirSync(paths.codexDir, { recursive: true });
  fs.writeFileSync(paths.codexConfig, upsertCodexToml(existing, launch), "utf8");
}

function connectCopilotVscode(launch: McpLaunch) {
  // VS Code user-level MCP config (used by GitHub Copilot agent mode).
  const cfg = readJson(paths.vscodeMcp) ?? {};
  cfg.servers = {
    ...(cfg.servers ?? {}),
    oatmeal: { type: "stdio", command: launch.command, args: launch.args, env: launch.env },
  };
  writeJson(paths.vscodeMcp, cfg);
}

function connectCopilotCli(launch: McpLaunch) {
  const cfg = readJson(paths.copilotCliConfig) ?? {};
  cfg.mcpServers = {
    ...(cfg.mcpServers ?? {}),
    oatmeal: {
      type: "local",
      command: launch.command,
      args: launch.args,
      env: launch.env,
      tools: ["*"],
    },
  };
  writeJson(paths.copilotCliConfig, cfg);
}

// --- entry inspection, CLI commands, launching ---

const sh = (s: string) => (/[^\w@%+=:,./-]/.test(s) ? `'${s.replace(/'/g, `'\\''`)}'` : s);

// Summarize a configured entry ({command, args}) and whether its script is gone.
function inspectEntry(entry: { command?: string; args?: string[] } | null | undefined): {
  detail: string | null;
  stale: boolean;
} {
  if (!entry?.command) return { detail: null, stale: false };
  const args = entry.args ?? [];
  const script = [...args].reverse().find((a) => a.endsWith(".js"));
  const viaApp = entry.command.includes("Oatmeal.app") || entry.command === process.execPath;
  const detail = script
    ? `runs ${viaApp ? "the bundled server" : script} via ${viaApp ? "Oatmeal" : path.basename(entry.command)}`
    : `runs ${path.basename(entry.command)}`;
  const stale =
    (script != null && !fs.existsSync(script)) ||
    (!!entry.command.startsWith("/") && !fs.existsSync(entry.command));
  return { detail, stale };
}

function codexEntryFromToml(): { command?: string; args?: string[] } | null {
  if (!fs.existsSync(paths.codexConfig)) return null;
  const toml = fs.readFileSync(paths.codexConfig, "utf8");
  const m = toml.match(/\[mcp_servers\.oatmeal\]([^[]*)/);
  if (!m) return null;
  const cmd = m[1].match(/command\s*=\s*"((?:[^"\\]|\\.)*)"/)?.[1];
  const argsRaw = m[1].match(/args\s*=\s*\[([^\]]*)\]/)?.[1] ?? "";
  const args = [...argsRaw.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((x) => x[1]);
  return cmd ? { command: cmd, args } : null;
}

// Paste-ready one-liner for CLI tools (user can also just click Connect).
// Verified forms: `claude mcp add` refuses to overwrite, so remove first
// (name must precede -e — its --env flag is variadic); `codex mcp add`
// overwrites in place.
function cliCommandFor(id: IntegrationId, launch: McpLaunch): string | null {
  const bin = sh(launch.command);
  const args = launch.args.map(sh).join(" ");
  switch (id) {
    case "claude-code":
      return `claude mcp remove oatmeal -s user >/dev/null 2>&1; claude mcp add oatmeal -s user -e ELECTRON_RUN_AS_NODE=1 -- ${bin} ${args}`;
    case "codex":
      return `codex mcp add oatmeal --env ELECTRON_RUN_AS_NODE=1 -- ${bin} ${args}`;
    default:
      return null; // GUI tools (config write) or no non-interactive CLI
  }
}

const OPENABLE: Partial<Record<IntegrationId, { app: string; webFallback: string }>> = {
  "claude-desktop": { app: "Claude", webFallback: "https://claude.ai" },
  "copilot-vscode": {
    app: "Visual Studio Code",
    webFallback: "https://code.visualstudio.com",
  },
};

function appExists(name: string): boolean {
  return fs.existsSync(`/Applications/${name}.app`);
}

// Launch the connected tool (or its web fallback) so the user lands in it.
export async function openIntegration(id: IntegrationId): Promise<void> {
  const target = OPENABLE[id];
  if (!target) return;
  if (appExists(target.app)) {
    spawn("open", ["-a", target.app], { detached: true, stdio: "ignore" }).unref();
  } else {
    await shell.openExternal(target.webFallback);
  }
}

// --- status + registry ---

const TOOLS: {
  id: IntegrationId;
  label: string;
  installed: () => boolean;
  configPath: string;
  entry: () => { command?: string; args?: string[] } | null;
  connect: (launch: McpLaunch) => void;
}[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    installed: () => fs.existsSync(paths.claudeCode),
    configPath: paths.claudeCode,
    entry: () => readJson(paths.claudeCode)?.mcpServers?.oatmeal ?? null,
    connect: connectClaudeCode,
  },
  {
    id: "claude-desktop",
    label: "Claude Desktop",
    installed: () =>
      appExists("Claude") || fs.existsSync(path.dirname(paths.claudeDesktop)),
    configPath: paths.claudeDesktop,
    entry: () => readJson(paths.claudeDesktop)?.mcpServers?.oatmeal ?? null,
    connect: connectClaudeDesktop,
  },
  {
    id: "codex",
    label: "Codex CLI",
    installed: () => fs.existsSync(paths.codexDir),
    configPath: paths.codexConfig,
    entry: codexEntryFromToml,
    connect: connectCodex,
  },
  {
    id: "copilot-vscode",
    label: "GitHub Copilot (VS Code)",
    installed: () => fs.existsSync(paths.vscodeUserDir),
    configPath: paths.vscodeMcp,
    entry: () => readJson(paths.vscodeMcp)?.servers?.oatmeal ?? null,
    connect: connectCopilotVscode,
  },
  {
    id: "copilot-cli",
    label: "GitHub Copilot CLI",
    installed: () => fs.existsSync(paths.copilotCliDir),
    configPath: paths.copilotCliConfig,
    entry: () => readJson(paths.copilotCliConfig)?.mcpServers?.oatmeal ?? null,
    connect: connectCopilotCli,
  },
];

export function integrationStatus(): IntegrationStatus[] {
  const launch = mcpLaunch();
  return TOOLS.map((t) => {
    const entry = t.entry();
    const { detail, stale } = inspectEntry(entry);
    return {
      id: t.id,
      label: t.label,
      installed: t.installed(),
      connected: entry != null,
      stale,
      detail,
      cliCommand: cliCommandFor(t.id, launch),
      openable: t.id in OPENABLE,
      configPath: t.configPath,
    };
  });
}

export function connectIntegration(id: IntegrationId): IntegrationStatus[] {
  const tool = TOOLS.find((t) => t.id === id);
  if (!tool) throw new Error(`unknown integration: ${id}`);
  tool.connect(mcpLaunch());
  return integrationStatus();
}
