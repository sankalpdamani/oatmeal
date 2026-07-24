// One-click MCP integrations: write the Oatmeal MCP server into the config of
// each AI coding tool the user has installed (Claude Code, Claude Desktop,
// Codex CLI, GitHub Copilot in VS Code, Copilot CLI).
//
// The MCP server is bundled with the app (resources/mcp/index.js) and runs via
// Oatmeal's own binary with ELECTRON_RUN_AS_NODE — no Node.js install needed.
// Transcripts never leave the machine: the tool spawns the server locally over
// stdio and reads the local SQLite database.
import { app } from "electron";
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

// --- status + registry ---

const TOOLS: {
  id: IntegrationId;
  label: string;
  installed: () => boolean;
  configPath: string;
  connected: () => boolean;
  connect: (launch: McpLaunch) => void;
}[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    installed: () => fs.existsSync(paths.claudeCode),
    configPath: paths.claudeCode,
    connected: () => !!readJson(paths.claudeCode)?.mcpServers?.oatmeal,
    connect: connectClaudeCode,
  },
  {
    id: "claude-desktop",
    label: "Claude Desktop",
    installed: () => fs.existsSync(path.dirname(paths.claudeDesktop)),
    configPath: paths.claudeDesktop,
    connected: () => !!readJson(paths.claudeDesktop)?.mcpServers?.oatmeal,
    connect: connectClaudeDesktop,
  },
  {
    id: "codex",
    label: "Codex CLI",
    installed: () => fs.existsSync(paths.codexDir),
    configPath: paths.codexConfig,
    connected: () =>
      fs.existsSync(paths.codexConfig) &&
      /\[mcp_servers\.oatmeal\]/.test(fs.readFileSync(paths.codexConfig, "utf8")),
    connect: connectCodex,
  },
  {
    id: "copilot-vscode",
    label: "GitHub Copilot (VS Code)",
    installed: () => fs.existsSync(paths.vscodeUserDir),
    configPath: paths.vscodeMcp,
    connected: () => !!readJson(paths.vscodeMcp)?.servers?.oatmeal,
    connect: connectCopilotVscode,
  },
  {
    id: "copilot-cli",
    label: "GitHub Copilot CLI",
    installed: () => fs.existsSync(paths.copilotCliDir),
    configPath: paths.copilotCliConfig,
    connected: () => !!readJson(paths.copilotCliConfig)?.mcpServers?.oatmeal,
    connect: connectCopilotCli,
  },
];

export function integrationStatus(): IntegrationStatus[] {
  return TOOLS.map((t) => ({
    id: t.id,
    label: t.label,
    installed: t.installed(),
    connected: t.connected(),
    configPath: t.configPath,
  }));
}

export function connectIntegration(id: IntegrationId): IntegrationStatus[] {
  const tool = TOOLS.find((t) => t.id === id);
  if (!tool) throw new Error(`unknown integration: ${id}`);
  tool.connect(mcpLaunch());
  return integrationStatus();
}
