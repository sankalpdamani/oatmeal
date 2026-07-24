import { describe, expect, it } from "vitest";
import { upsertCodexToml } from "../electron/mcp-config";
import { isNewer, parseVersion } from "../electron/version";

const launch = {
  command: "/Applications/Oatmeal.app/Contents/MacOS/Oatmeal",
  args: ["--no-warnings", "/Applications/Oatmeal.app/Contents/Resources/mcp/index.js"],
  env: { ELECTRON_RUN_AS_NODE: "1" },
};

describe("upsertCodexToml", () => {
  it("appends to an empty config", () => {
    const out = upsertCodexToml("", launch);
    expect(out).toContain("[mcp_servers.oatmeal]");
    expect(out).toContain("[mcp_servers.oatmeal.env]");
    expect(out).toContain('ELECTRON_RUN_AS_NODE = "1"');
  });

  it("preserves unrelated sections", () => {
    const existing = 'model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "foo"\n';
    const out = upsertCodexToml(existing, launch);
    expect(out).toContain('model = "gpt-5"');
    expect(out).toContain("[mcp_servers.other]");
    expect(out).toContain("[mcp_servers.oatmeal]");
  });

  it("is idempotent — reconnecting replaces, not duplicates", () => {
    const once = upsertCodexToml("", launch);
    const twice = upsertCodexToml(once, launch);
    expect(twice.match(/\[mcp_servers\.oatmeal\]/g)).toHaveLength(1);
    expect(twice.match(/\[mcp_servers\.oatmeal\.env\]/g)).toHaveLength(1);
  });
});

describe("version compare", () => {
  it("parses tags with and without v", () => {
    expect(parseVersion("v1.2.3")).toEqual([1, 2, 3]);
    expect(parseVersion("0.1.1")).toEqual([0, 1, 1]);
    expect(parseVersion("nightly")).toBeNull();
  });
  it("orders correctly", () => {
    expect(isNewer("v0.2.0", "0.1.9")).toBe(true);
    expect(isNewer("v0.1.1", "0.1.1")).toBe(false);
    expect(isNewer("0.1.0", "0.1.1")).toBe(false);
    expect(isNewer("garbage", "0.1.1")).toBe(false);
  });
});
