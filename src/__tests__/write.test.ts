import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerWrite } from "../tools/write.js";

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

describe("write_file tool", () => {
  let tmpDir: string;
  let mock: ReturnType<typeof makeMockServer>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "mcp-write-test-"));
    mock = makeMockServer();
    registerWrite(mock.server);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes content to a new file", async () => {
    const filePath = join(tmpDir, "out.txt");
    const result = await mock.call("write_file", { file_path: filePath, content: "hello world" });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("bytes");
    expect(readFileSync(filePath, "utf-8")).toBe("hello world");
  });

  it("overwrites existing file content", async () => {
    const filePath = join(tmpDir, "out.txt");
    await mock.call("write_file", { file_path: filePath, content: "original" });
    await mock.call("write_file", { file_path: filePath, content: "updated" });
    expect(readFileSync(filePath, "utf-8")).toBe("updated");
  });

  it("creates parent directories by default", async () => {
    const filePath = join(tmpDir, "nested", "deep", "file.txt");
    const result = await mock.call("write_file", { file_path: filePath, content: "nested" });
    expect(result.isError).toBeUndefined();
    expect(existsSync(filePath)).toBe(true);
  });

  it("returns error when create_dirs is false and parent dir is missing", async () => {
    const filePath = join(tmpDir, "missing-dir", "file.txt");
    const result = await mock.call("write_file", { file_path: filePath, content: "x", create_dirs: false });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Error:");
  });

  it("reports correct byte count in result", async () => {
    const filePath = join(tmpDir, "bytes.txt");
    const content = "abc";
    const result = await mock.call("write_file", { file_path: filePath, content });
    expect(result.content[0].text).toContain("3 bytes");
  });

  it("writes empty content successfully", async () => {
    const filePath = join(tmpDir, "empty.txt");
    const result = await mock.call("write_file", { file_path: filePath, content: "" });
    expect(result.isError).toBeUndefined();
    expect(readFileSync(filePath, "utf-8")).toBe("");
  });

  it("writes multiline content preserving newlines", async () => {
    const filePath = join(tmpDir, "multi.txt");
    const content = "line1\nline2\nline3\n";
    await mock.call("write_file", { file_path: filePath, content });
    expect(readFileSync(filePath, "utf-8")).toBe(content);
  });
});
