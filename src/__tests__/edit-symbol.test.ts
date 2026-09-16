import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerEditSymbol } from "../tools/edit-symbol.js";
import { registerEdit } from "../tools/edit.js";

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: { type: string; text: string }[];
  isError?: boolean;
}>;

function makeMockServer() {
  const handlers = new Map<string, ToolHandler>();
  const server = {
    tool: (_n: string, _d: string, _s: unknown, h: ToolHandler) => { handlers.set(_n, h); },
  };
  return {
    server: server as unknown as McpServer,
    call: (name: string, args: Record<string, unknown>) => handlers.get(name)!(args),
  };
}

describe("edit_symbol tool", () => {
  let tmpDir: string;
  let mock: ReturnType<typeof makeMockServer>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "mcp-editsym-"));
    mock = makeMockServer();
    registerEditSymbol(mock.server);
  });
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  it("replaces a function body by name, leaving siblings untouched", async () => {
    const f = join(tmpDir, "x.ts");
    writeFileSync(f, "export function add(a: number, b: number) {\n  return a + b;\n}\n\nexport const Y = 1;\n");
    const res = await mock.call("edit_symbol", {
      file_path: f,
      symbol_name: "add",
      new_body: "export function add(a: number, b: number): number {\n  return a + b + 100;\n}",
    });
    expect(res.isError).toBeUndefined();
    const after = readFileSync(f, "utf-8");
    expect(after).toContain("a + b + 100");
    expect(after).toContain("): number");
    expect(after).toContain("export const Y = 1;"); // sibling untouched
  });

  it("errors clearly when the symbol is not found", async () => {
    const f = join(tmpDir, "x.ts");
    writeFileSync(f, "export const a = 1;\n");
    const res = await mock.call("edit_symbol", { file_path: f, symbol_name: "nope", new_body: "x" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("not found");
  });

  it("rejects unsupported file types", async () => {
    const f = join(tmpDir, "x.txt");
    writeFileSync(f, "hello\n");
    const res = await mock.call("edit_symbol", { file_path: f, symbol_name: "x", new_body: "y" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("Unsupported");
  });
});

describe("edit_file CRLF matching (autocrlf trap)", () => {
  let tmpDir: string;
  let mock: ReturnType<typeof makeMockServer>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "mcp-editcrlf-"));
    mock = makeMockServer();
    registerEdit(mock.server);
  });
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  it("matches LF old_text against a CRLF file and preserves CRLF", async () => {
    const f = join(tmpDir, "c.ts");
    writeFileSync(f, "line one\r\nline two\r\nline three\r\n"); // CRLF working copy
    const res = await mock.call("edit_file", {
      file_path: f,
      old_text: "line one\nline two", // agent sends LF
      new_text: "LINE ONE\nLINE TWO",
    });
    expect(res.isError).toBeUndefined();
    const after = readFileSync(f, "utf-8");
    expect(after).toContain("LINE ONE\r\nLINE TWO"); // EOL preserved as CRLF
    expect(after).not.toContain("line one");
  });
});
