import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerGlob } from "../tools/glob.js";

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: { type: string; text: string }[];
  isError?: boolean;
}>;

function makeMockServer() {
  const handlers = new Map<string, ToolHandler>();
  const server = {
    tool: (_name: string, _desc: string, _schema: unknown, handler: ToolHandler) => {
      handlers.set(_name, handler);
    },
  };
  return {
    server: server as unknown as McpServer,
    call: (name: string, args: Record<string, unknown>) => handlers.get(name)!(args),
  };
}

describe("glob_files tool", () => {
  let tmpDir: string;
  let mock: ReturnType<typeof makeMockServer>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "mcp-glob-test-"));
    mock = makeMockServer();
    registerGlob(mock.server);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("finds files matching a glob pattern", async () => {
    writeFileSync(join(tmpDir, "a.ts"), "");
    writeFileSync(join(tmpDir, "b.ts"), "");
    writeFileSync(join(tmpDir, "c.js"), "");
    const result = await mock.call("glob_files", { pattern: "**/*.ts", path: tmpDir });
    const text = result.content[0].text;
    expect(text).toContain("a.ts");
    expect(text).toContain("b.ts");
    expect(text).not.toContain("c.js");
  });

  it("returns (no matches) when no files match", async () => {
    const result = await mock.call("glob_files", { pattern: "**/*.nonexistent", path: tmpDir });
    expect(result.content[0].text).toBe("(no matches)");
  });

  it("returns absolute paths", async () => {
    writeFileSync(join(tmpDir, "file.txt"), "");
    const result = await mock.call("glob_files", { pattern: "*.txt", path: tmpDir });
    expect(result.content[0].text).toContain(tmpDir);
  });

  it("respects max_results limit", async () => {
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(tmpDir, `file${i}.txt`), "");
    }
    const result = await mock.call("glob_files", { pattern: "*.txt", path: tmpDir, max_results: 2 });
    const text = result.content[0].text;
    const lines = text.split("\n").filter((l) => l.trim() && !l.startsWith("("));
    expect(lines.length).toBe(2);
    expect(text).toContain("total matches");
  });

  it("excludes node_modules by default", async () => {
    mkdirSync(join(tmpDir, "node_modules"), { recursive: true });
    writeFileSync(join(tmpDir, "node_modules", "pkg.ts"), "");
    writeFileSync(join(tmpDir, "real.ts"), "");
    const result = await mock.call("glob_files", { pattern: "**/*.ts", path: tmpDir });
    expect(result.content[0].text).not.toContain("node_modules");
    expect(result.content[0].text).toContain("real.ts");
  });

  it("excludes .git directories by default", async () => {
    mkdirSync(join(tmpDir, ".git"), { recursive: true });
    writeFileSync(join(tmpDir, ".git", "config"), "");
    writeFileSync(join(tmpDir, "src.ts"), "");
    const result = await mock.call("glob_files", { pattern: "**/*", path: tmpDir });
    expect(result.content[0].text).not.toContain(".git");
  });

  it("finds files inside dot-directories (e.g. .claude/)", async () => {
    mkdirSync(join(tmpDir, ".claude", "skills"), { recursive: true });
    writeFileSync(join(tmpDir, ".claude", "skills", "colony.md"), "");
    writeFileSync(join(tmpDir, ".claude", "CLAUDE.md"), "");
    writeFileSync(join(tmpDir, "top.md"), "");
    const result = await mock.call("glob_files", { pattern: "**/*.md", path: tmpDir });
    const text = result.content[0].text;
    expect(text).toContain("colony.md");
    expect(text).toContain("CLAUDE.md");
    expect(text).toContain("top.md");
  });

  it("matches nested files with ** pattern", async () => {
    mkdirSync(join(tmpDir, "src", "utils"), { recursive: true });
    writeFileSync(join(tmpDir, "src", "index.ts"), "");
    writeFileSync(join(tmpDir, "src", "utils", "helper.ts"), "");
    const result = await mock.call("glob_files", { pattern: "**/*.ts", path: tmpDir });
    const text = result.content[0].text;
    expect(text).toContain("index.ts");
    expect(text).toContain("helper.ts");
  });
});
