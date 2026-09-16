import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerRead } from "../tools/read.js";

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

describe("read_file tool", () => {
  let tmpDir: string;
  let mock: ReturnType<typeof makeMockServer>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "mcp-read-test-"));
    mock = makeMockServer();
    registerRead(mock.server);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reads a file with line numbers", async () => {
    writeFileSync(join(tmpDir, "file.txt"), "line one\nline two\nline three\n");
    const result = await mock.call("read_file", { file_path: join(tmpDir, "file.txt") });
    const text = result.content[0].text;
    expect(text).toContain("line one");
    expect(text).toContain("line two");
    expect(text).toContain("line three");
    // Should include line numbers in padded format
    expect(text).toMatch(/\d+\s*│/);
  });

  it("returns (empty file) for an empty file", async () => {
    writeFileSync(join(tmpDir, "empty.txt"), "");
    const result = await mock.call("read_file", { file_path: join(tmpDir, "empty.txt") });
    expect(result.content[0].text).toBe("(empty file)");
  });

  it("respects offset (1-based line number)", async () => {
    writeFileSync(join(tmpDir, "lines.txt"), "a\nb\nc\nd\ne\n");
    const result = await mock.call("read_file", { file_path: join(tmpDir, "lines.txt"), offset: 3 });
    const text = result.content[0].text;
    expect(text).toContain("c");
    expect(text).not.toContain("│ a");
    expect(text).not.toContain("│ b");
  });

  it("respects limit", async () => {
    writeFileSync(join(tmpDir, "lines.txt"), "a\nb\nc\nd\ne\n");
    const result = await mock.call("read_file", { file_path: join(tmpDir, "lines.txt"), limit: 2 });
    const text = result.content[0].text;
    expect(text).toContain("a");
    expect(text).toContain("b");
    expect(text).toContain("total lines");
  });

  it("returns error for missing file", async () => {
    const result = await mock.call("read_file", { file_path: join(tmpDir, "nonexistent.txt") });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Error:");
  });

  it("returns error when path is a directory", async () => {
    const result = await mock.call("read_file", { file_path: tmpDir });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("directory");
  });

  it("detects binary files and refuses to display contents", async () => {
    // Write a buffer with a null byte (binary indicator)
    const buf = Buffer.alloc(100);
    buf[42] = 0x00;
    writeFileSync(join(tmpDir, "binary.bin"), buf);
    const result = await mock.call("read_file", { file_path: join(tmpDir, "binary.bin") });
    expect(result.content[0].text).toContain("Binary file");
    expect(result.isError).toBeUndefined();
  });

  it("includes total line count summary when content is paginated", async () => {
    const content = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n");
    writeFileSync(join(tmpDir, "big.txt"), content);
    const result = await mock.call("read_file", { file_path: join(tmpDir, "big.txt"), limit: 10 });
    expect(result.content[0].text).toContain("total lines");
  });

  // ── token-funnel integration ────────────────────────────
  // read.ts replaced its truncation block with funnel(output, "file-read", …). The
  // file-read profile's preprocess/postprocess strip and re-attach the numbered
  // gutter around dedup/classification — these confirm that survives the real
  // read_file call, not just a direct compressFileRead() call.

  it("compresses content over the output budget while preserving line-number gutters", async () => {
    const lines = Array.from({ length: 5000 }, (_, i) => `content line ${i} with some padding text here`);
    writeFileSync(join(tmpDir, "big.txt"), lines.join("\n"));
    const result = await mock.call("read_file", { file_path: join(tmpDir, "big.txt"), limit: 5000 });
    const text = result.content[0].text;
    expect(text.length).toBeLessThan(lines.join("\n").length);
    expect(text).toMatch(/\d+\s*│\s*content line 0 /);
    expect(text).toContain("│");
  });

  it("dedups identical lines despite differing gutter line numbers, and shows a numbered range", async () => {
    // The dedup-into-"(repeated N times)" placeholder always renders regardless of
    // budget outcome — but read.ts only calls funnel() at all once output clears
    // MAX_OUTPUT, so the repeated block must be long enough to cross that threshold
    // on its own (short inputs pass through untouched, verified elsewhere).
    const lines = [
      ...Array.from({ length: 5 }, (_, i) => `unique line ${i + 1}`),
      ...Array.from({ length: 3000 }, () => "    return null;"),
      ...Array.from({ length: 5 }, (_, i) => `unique line ${i + 3006}`),
    ];
    writeFileSync(join(tmpDir, "dup.txt"), lines.join("\n"));
    const result = await mock.call("read_file", {
      file_path: join(tmpDir, "dup.txt"),
      limit: lines.length,
    });
    const text = result.content[0].text;
    expect(text.length).toBeLessThan(lines.join("\n").length);
    expect(text).toContain("unique line 1");
    expect(text).toContain("unique line 3010");
    expect(text).toContain("(repeated 3000 times)");
    expect(text).not.toContain("    return null;\n    return null;");
  });
});
