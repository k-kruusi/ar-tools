import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerEditRange } from "../tools/edit-range.js";

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

describe("edit_range tool", () => {
  let tmpDir: string;
  let mock: ReturnType<typeof makeMockServer>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "mcp-editrange-"));
    mock = makeMockServer();
    registerEditRange(mock.server);
  });
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  it("replaces a mid-file span by line numbers", async () => {
    const f = join(tmpDir, "f.txt");
    writeFileSync(f, "line1\nline2\nline3\nline4\nline5\n");
    const res = await mock.call("edit_range", {
      file_path: f, start_line: 2, end_line: 4, new_text: "replaced",
    });
    expect(res.isError).toBeUndefined();
    expect(readFileSync(f, "utf-8")).toBe("line1\nreplaced\nline5\n");
    expect(res.content[0].text).toContain("3 → 1 lines");
  });

  it("inserts without deleting when end_line = start_line - 1", async () => {
    const f = join(tmpDir, "f.txt");
    writeFileSync(f, "A\nB\nC\n");
    const res = await mock.call("edit_range", {
      file_path: f, start_line: 2, end_line: 1, new_text: "INSERTED",
    });
    expect(res.isError).toBeUndefined();
    expect(readFileSync(f, "utf-8")).toBe("A\nINSERTED\nB\nC\n");
  });

  it("appends after the last line of a trailing-newline file (start_line = read_file's total line count)", async () => {
    // "A\nB\n".split(/\r?\n/) has a trailing "" element, so read_file numbers a
    // phantom blank line 3 — inserting there (start_line: 3, end_line: 2) is how
    // an agent appends after "B" using the exact line numbers read_file showed it.
    const f = join(tmpDir, "f.txt");
    writeFileSync(f, "A\nB\n");
    const res = await mock.call("edit_range", {
      file_path: f, start_line: 3, end_line: 2, new_text: "C",
    });
    expect(res.isError).toBeUndefined();
    expect(readFileSync(f, "utf-8")).toBe("A\nB\nC\n");
  });

  it("appends at EOF via start_line = totalLines + 1 for a file with no trailing newline", async () => {
    const f = join(tmpDir, "f.txt");
    writeFileSync(f, "A\nB");
    const res = await mock.call("edit_range", {
      file_path: f, start_line: 3, end_line: 2, new_text: "C",
    });
    expect(res.isError).toBeUndefined();
    expect(readFileSync(f, "utf-8")).toBe("A\nB\nC");
  });

  it("deletes a span when new_text is empty", async () => {
    const f = join(tmpDir, "f.txt");
    writeFileSync(f, "keep\ndelete1\ndelete2\nkeep2\n");
    const res = await mock.call("edit_range", {
      file_path: f, start_line: 2, end_line: 3, new_text: "",
    });
    expect(res.isError).toBeUndefined();
    expect(readFileSync(f, "utf-8")).toBe("keep\nkeep2\n");
  });

  it("replaces a single line via start_line: N, end_line: N", async () => {
    const f = join(tmpDir, "f.txt");
    writeFileSync(f, "one\ntwo\nthree\n");
    const res = await mock.call("edit_range", {
      file_path: f, start_line: 2, end_line: 2, new_text: "TWO",
    });
    expect(res.isError).toBeUndefined();
    expect(readFileSync(f, "utf-8")).toBe("one\nTWO\nthree\n");
  });

  it("returns isError for out-of-bounds end_line", async () => {
    const f = join(tmpDir, "f.txt");
    writeFileSync(f, "one\ntwo\n");
    const res = await mock.call("edit_range", {
      file_path: f, start_line: 1, end_line: 99, new_text: "x",
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("exceeds");
    // Unchanged on refusal.
    expect(readFileSync(f, "utf-8")).toBe("one\ntwo\n");
  });

  it("returns isError for start_line < 1", async () => {
    const f = join(tmpDir, "f.txt");
    writeFileSync(f, "one\n");
    const res = await mock.call("edit_range", {
      file_path: f, start_line: 0, end_line: 1, new_text: "x",
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("start_line");
  });

  it("returns isError when end_line < start_line - 1", async () => {
    const f = join(tmpDir, "f.txt");
    writeFileSync(f, "one\ntwo\n");
    const res = await mock.call("edit_range", {
      file_path: f, start_line: 2, end_line: 0, new_text: "x",
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("end_line");
  });

  it("returns isError when start_line is far beyond EOF (attributed to start_line, not end_line)", async () => {
    // end_line = start_line - 1 satisfies the insertion contract, so only the
    // start_line-vs-EOF check can catch this — proving it isn't dead code
    // shadowed by the end_line bound.
    const f = join(tmpDir, "f.txt");
    writeFileSync(f, "one\n");
    const res = await mock.call("edit_range", {
      file_path: f, start_line: 10, end_line: 9, new_text: "x",
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("start_line");
    expect(res.content[0].text).toContain("exceeds file length");
  });

  it("preserves CRLF line endings", async () => {
    const f = join(tmpDir, "f.txt");
    writeFileSync(f, "alpha\r\nbeta\r\ngamma\r\n");
    const res = await mock.call("edit_range", {
      file_path: f, start_line: 2, end_line: 2, new_text: "BETA",
    });
    expect(res.isError).toBeUndefined();
    const after = readFileSync(f, "utf-8");
    expect(after).toBe("alpha\r\nBETA\r\ngamma\r\n");
    expect(after.includes("\r\n")).toBe(true);
    // No lone LF.
    expect(/[^\r]\n/.test(after)).toBe(false);
  });

  it("preserves LF line endings when new_text has CRLF", async () => {
    const f = join(tmpDir, "f.txt");
    writeFileSync(f, "alpha\nbeta\ngamma\n");
    const res = await mock.call("edit_range", {
      file_path: f, start_line: 2, end_line: 2, new_text: "BETA\r\nEXTRA",
    });
    expect(res.isError).toBeUndefined();
    const after = readFileSync(f, "utf-8");
    expect(after).toBe("alpha\nBETA\nEXTRA\ngamma\n");
    expect(after.includes("\r\n")).toBe(false);
  });

  it("echoes replaced content in the success message", async () => {
    const f = join(tmpDir, "f.txt");
    writeFileSync(f, "first\nsecond\nthird\n");
    const res = await mock.call("edit_range", {
      file_path: f, start_line: 2, end_line: 2, new_text: "REPLACED",
    });
    expect(res.content[0].text).toContain("Replaced content");
    expect(res.content[0].text).toContain("second");
  });

  it("omits the replaced-content echo on pure insertion (nothing replaced)", async () => {
    const f = join(tmpDir, "f.txt");
    writeFileSync(f, "A\nB\n");
    const res = await mock.call("edit_range", {
      file_path: f, start_line: 2, end_line: 1, new_text: "X",
    });
    expect(res.content[0].text).not.toContain("Replaced content");
  });

  it("errors clearly for a nonexistent file", async () => {
    const res = await mock.call("edit_range", {
      file_path: join(tmpDir, "nope.txt"), start_line: 1, end_line: 1, new_text: "x",
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("Error");
  });
});
