import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerEdit } from "../tools/edit.js";
import {
  replaceWithStrategy,
  isDisproportionateMatch,
  LineTrimmedReplacer,
  BlockAnchorReplacer,
  WhitespaceNormalizedReplacer,
} from "../lib/replacers.js";

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

// ── Pure unit tests on the replacer cascade (no fs / tree-sitter) ──────────────
describe("replacers (pure)", () => {
  it("isDisproportionateMatch: single-line old never disproportionate by line count", () => {
    expect(isDisproportionateMatch("a", "b")).toBe(false);
  });

  it("isDisproportionateMatch: span with many more lines is disproportionate", () => {
    const search = Array.from({ length: 10 }, (_, i) => `line${i}`).join("\n");
    expect(isDisproportionateMatch(search, "line0\nline1")).toBe(true);
  });

  it("isDisproportionateMatch: single-line huge span trips the length guard", () => {
    // oldLines must be > 1 to reach the length branch
    const oldString = "x\ny";
    const search = "x\n" + "z".repeat(2000);
    expect(isDisproportionateMatch(search, oldString)).toBe(true);
  });

  it("LineTrimmedReplacer yields the real (un-trimmed) span", () => {
    const content = "function f() {\n    return 1;\n}\n";
    const find = "function f() {\nreturn 1;\n}"; // indentation dropped
    const yielded = [...LineTrimmedReplacer(content, find)];
    expect(yielded).toContain("function f() {\n    return 1;\n}");
  });

  it("BlockAnchorReplacer matches with a reformatted middle line", () => {
    const content = "start\n    middle_actual_text\nend\n";
    const find = "start\n    middle_actuel_txt\nend"; // typo'd middle, anchors intact
    const yielded = [...BlockAnchorReplacer(content, find)];
    expect(yielded.length).toBe(1);
    expect(yielded[0]).toContain("middle_actual_text");
  });

  it("WhitespaceNormalizedReplacer collapses internal whitespace runs", () => {
    const content = "const  x   =    1;\n";
    const find = "const x = 1;";
    const yielded = [...WhitespaceNormalizedReplacer(content, find)];
    expect(yielded).toContain("const  x   =    1;");
  });

  it("replaceWithStrategy reports the exact strategy for clean matches", () => {
    const r = replaceWithStrategy("hello world", "hello world", "bye");
    expect(r.strategy).toBe("exact");
    expect(r.content).toBe("bye");
    expect(r.count).toBe(1);
  });
});

// ── Integration tests through registerEdit (exercises EOL + ripple path) ───────
describe("edit_file fuzzy replacer cascade", () => {
  let tmpDir: string;
  let mock: ReturnType<typeof makeMockServer>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "mcp-edit-fuzzy-"));
    mock = makeMockServer();
    registerEdit(mock.server);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("exact match still works", async () => {
    const filePath = join(tmpDir, "f.txt");
    writeFileSync(filePath, "alpha beta gamma\n");
    const result = await mock.call("edit_file", {
      file_path: filePath,
      old_text: "alpha beta gamma",
      new_text: "one two three",
    });
    expect(result.isError).toBeUndefined();
    expect(readFileSync(filePath, "utf-8")).toBe("one two three\n");
    expect(result.content[0].text).toContain("1 occurrence");
  });

  it("matches across per-line trailing/leading whitespace drift", async () => {
    const filePath = join(tmpDir, "f.txt");
    // File has trailing spaces on lines the agent won't reproduce.
    writeFileSync(filePath, "foo   \n  bar\nbaz\n");
    const result = await mock.call("edit_file", {
      file_path: filePath,
      old_text: "foo\nbar\nbaz",
      new_text: "REPLACED",
    });
    expect(result.isError).toBeUndefined();
    expect(readFileSync(filePath, "utf-8")).toBe("REPLACED\n");
    expect(result.content[0].text).toMatch(/matched via line-trimmed/);
  });

  it("matches across indentation drift", async () => {
    const filePath = join(tmpDir, "f.ts");
    writeFileSync(filePath, "if (x) {\n        doThing();\n}\n");
    const result = await mock.call("edit_file", {
      file_path: filePath,
      // old_text uses 2-space indent, file uses 8
      old_text: "if (x) {\n  doThing();\n}",
      new_text: "if (x) { done(); }",
    });
    expect(result.isError).toBeUndefined();
    expect(readFileSync(filePath, "utf-8")).toBe("if (x) { done(); }\n");
  });

  it("REFUSES a disproportionate / oversize match (length guard via block-anchor)", async () => {
    const filePath = join(tmpDir, "f.txt");
    // 3-line block-anchor match: anchors + middle line trim-equal, so it matches
    // (similarity 1.0). But the file's middle line carries ~700 trailing spaces,
    // so the matched span is far longer than old_text -> length-branch refusal.
    const fatMiddle = "  mid = compute();" + " ".repeat(700);
    writeFileSync(filePath, `TOP\n${fatMiddle}\nBOT\n`);
    const result = await mock.call("edit_file", {
      file_path: filePath,
      old_text: "TOP\nmid = compute();\nBOT", // short; matched span is huge
      new_text: "SMALL",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/larger|oversize/i);
    // File must be untouched on refusal.
    expect(readFileSync(filePath, "utf-8")).toBe(`TOP\n${fatMiddle}\nBOT\n`);
  });

  it("not-found → isError", async () => {
    const filePath = join(tmpDir, "f.txt");
    writeFileSync(filePath, "hello\n");
    const result = await mock.call("edit_file", {
      file_path: filePath,
      old_text: "totally absent",
      new_text: "x",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/not found/i);
  });

  it("ambiguous multiple-match → isError", async () => {
    const filePath = join(tmpDir, "f.txt");
    // Two lines that are identical after trimming → line-trimmed match is non-unique.
    writeFileSync(filePath, "  target\nmiddle\n  target\n");
    const result = await mock.call("edit_file", {
      file_path: filePath,
      old_text: "target",
      new_text: "x",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/multiple|appears|context/i);
    // unchanged
    expect(readFileSync(filePath, "utf-8")).toBe("  target\nmiddle\n  target\n");
  });

  it("matches a CRLF file with LF old_text and keeps the file CRLF", async () => {
    const filePath = join(tmpDir, "f.txt");
    writeFileSync(filePath, "alpha\r\nbeta\r\ngamma\r\n");
    const result = await mock.call("edit_file", {
      file_path: filePath,
      old_text: "alpha\nbeta", // LF supplied
      new_text: "one\ntwo",
    });
    expect(result.isError).toBeUndefined();
    const after = readFileSync(filePath, "utf-8");
    expect(after).toBe("one\r\ntwo\r\ngamma\r\n");
    expect(after.includes("\r\n")).toBe(true);
    // No lone LF (every \n must be preceded by \r)
    expect(/[^\r]\n/.test(after)).toBe(false);
  });

  it("replace_all replaces every occurrence and counts them", async () => {
    const filePath = join(tmpDir, "f.txt");
    writeFileSync(filePath, "x x x\n");
    const result = await mock.call("edit_file", {
      file_path: filePath,
      old_text: "x",
      new_text: "y",
      replace_all: true,
    });
    expect(result.isError).toBeUndefined();
    expect(readFileSync(filePath, "utf-8")).toBe("y y y\n");
    expect(result.content[0].text).toContain("3 occurrence");
  });

  it("not-found with similar content → error shows line numbers and a preview", async () => {
    const filePath = join(tmpDir, "f.txt");
    writeFileSync(filePath, "const alpha = 1;\nconst beta = 2;\nconst gamma = 3;\nconst delta = 4;\n");
    // First/last lines are wrong (defeats block-anchor's anchor requirement and
    // line-trimmed's exact-run requirement), but 2 of 4 lines match verbatim —
    // enough for the near-match sliding window (50% overlap) without any of the
    // four replacer strategies finding a match themselves.
    const result = await mock.call("edit_file", {
      file_path: filePath,
      old_text: "const alpha = 999;\nconst beta = 2;\nconst gamma = 3;\nconst delta = 888;",
      new_text: "REPLACED",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/not found/i);
    expect(result.content[0].text).toMatch(/similar|overlap/i);
    expect(result.content[0].text).toContain("const beta = 2;"); // preview context
    // File unchanged.
    expect(readFileSync(filePath, "utf-8")).toBe("const alpha = 1;\nconst beta = 2;\nconst gamma = 3;\nconst delta = 4;\n");
  });

  it("not-found with no similar content → error suggests wrong file", async () => {
    const filePath = join(tmpDir, "f.txt");
    writeFileSync(filePath, "alpha\nbeta\ngamma\n");
    const result = await mock.call("edit_file", {
      file_path: filePath,
      old_text: "completely unrelated text that has no overlap whatsoever with the file contents at all",
      new_text: "x",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/not found/i);
    expect(result.content[0].text).toMatch(/wrong file|file_path/i);
  });

  it("multiple-match with exact text → error shows line numbers", async () => {
    const filePath = join(tmpDir, "f.txt");
    writeFileSync(filePath, "target line\nmiddle\ntarget line\n");
    const result = await mock.call("edit_file", {
      file_path: filePath,
      old_text: "target line",
      new_text: "x",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/2 locations|lines 1/i);
    expect(result.content[0].text).toContain("replace_all");
    // File unchanged.
    expect(readFileSync(filePath, "utf-8")).toBe("target line\nmiddle\ntarget line\n");
  });
});
