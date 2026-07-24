// Pure config-file transforms for MCP integrations. No Electron imports —
// unit-tested directly.

export interface McpLaunch {
  command: string;
  args: string[];
  env: Record<string, string>;
}

// Codex CLI config is TOML. Replace any existing [mcp_servers.oatmeal] section
// (and its .env subtable) with a fresh one, preserving the rest of the file.
export function upsertCodexToml(existing: string, launch: McpLaunch): string {
  const section = [
    "[mcp_servers.oatmeal]",
    `command = ${JSON.stringify(launch.command)}`,
    `args = [${launch.args.map((a) => JSON.stringify(a)).join(", ")}]`,
    "",
    "[mcp_servers.oatmeal.env]",
    ...Object.entries(launch.env).map(([k, v]) => `${k} = ${JSON.stringify(v)}`),
  ].join("\n");
  const cleaned = existing
    .replace(/\[mcp_servers\.oatmeal(\.env)?\][^[]*/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
  return (cleaned ? cleaned + "\n\n" : "") + section + "\n";
}
