import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerEdit } from "../tools/edit.js";

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

describe("edit_file tool", () => {
  let tmpDir: string;
  let mock: ReturnType<typeof makeMockServer>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "mcp-edit-test-"));
    mock = makeMockServer();
    registerEdit(mock.server);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("replaces a unique occurrence of old_text", async () => {
    const filePath = join(tmpDir, "file.txt");
    writeFileSync(filePath, "hello world\n");
    const result = await mock.call("edit_file", {
      file_path: filePath,
      old_text: "hello world",
      new_text: "goodbye world",
    });
    expect(result.isError).toBeUndefined();
    expect(readFileSync(filePath, "utf-8")).toBe("goodbye world\n");
  });

  it("returns error when old_text is not found", async () => {
    const filePath = join(tmpDir, "file.txt");
    writeFileSync(filePath, "hello world\n");
    const result = await mock.call("edit_file", {
      file_path: filePath,
      old_text: "nonexistent text",
      new_text: "replacement",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not found");
  });

  it("returns error when old_text appears multiple times without replace_all", async () => {
    const filePath = join(tmpDir, "file.txt");
    writeFileSync(filePath, "foo foo foo\n");
    const result = await mock.call("edit_file", {
      file_path: filePath,
      old_text: "foo",
      new_text: "bar",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/3 locations|appears|not unique/i);
  });

  it("replaces all occurrences with replace_all: true", async () => {
    const filePath = join(tmpDir, "file.txt");
    writeFileSync(filePath, "foo foo foo\n");
    const result = await mock.call("edit_file", {
      file_path: filePath,
      old_text: "foo",
      new_text: "bar",
      replace_all: true,
    });
    expect(result.isError).toBeUndefined();
    expect(readFileSync(filePath, "utf-8")).toBe("bar bar bar\n");
    expect(result.content[0].text).toContain("3 occurrence");
  });

  it("handles multiline old_text replacement", async () => {
    const filePath = join(tmpDir, "file.txt");
    writeFileSync(filePath, "line1\nline2\nline3\n");
    const result = await mock.call("edit_file", {
      file_path: filePath,
      old_text: "line1\nline2",
      new_text: "replaced",
    });
    expect(result.isError).toBeUndefined();
    expect(readFileSync(filePath, "utf-8")).toBe("replaced\nline3\n");
  });

  it("returns error for missing file", async () => {
    const result = await mock.call("edit_file", {
      file_path: join(tmpDir, "nonexistent.txt"),
      old_text: "x",
      new_text: "y",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Error:");
  });

  it("reports replacement count in result message", async () => {
    const filePath = join(tmpDir, "file.txt");
    writeFileSync(filePath, "unique text here\n");
    const result = await mock.call("edit_file", {
      file_path: filePath,
      old_text: "unique text here",
      new_text: "something else",
    });
    expect(result.content[0].text).toContain("1 occurrence");
  });
});
