import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { buildRipgrepArgs, applyPagination, buildGrepFallbackArgs } from "../tools/grep.js";
import { registerGrep } from "../tools/grep.js";

// ── Mock server helper ────────────────────────────────────

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

// ── buildRipgrepArgs unit tests ───────────────────────────

describe("buildRipgrepArgs", () => {
  it("always includes --encoding auto (fix for #196: BOM/UTF-16 silent failures)", () => {
    const args = buildRipgrepArgs({ pattern: "foo", searchPath: "/tmp", outputMode: "content" });
    expect(args).toContain("--encoding");
    const encIdx = args.indexOf("--encoding");
    expect(args[encIdx + 1]).toBe("auto");
  });

  it("always suppresses color output", () => {
    const args = buildRipgrepArgs({ pattern: "foo", searchPath: "/tmp", outputMode: "content" });
    expect(args).toContain("--color");
    expect(args[args.indexOf("--color") + 1]).toBe("never");
  });

  it("always excludes node_modules and .git", () => {
    const args = buildRipgrepArgs({ pattern: "foo", searchPath: "/tmp", outputMode: "content" });
    expect(args).toContain("!node_modules/**");
    expect(args).toContain("!.git/**");
  });

  it("adds --files-with-matches for files_with_matches mode", () => {
    const args = buildRipgrepArgs({ pattern: "x", searchPath: "/tmp", outputMode: "files_with_matches" });
    expect(args).toContain("--files-with-matches");
  });

  it("adds --count for count mode", () => {
    const args = buildRipgrepArgs({ pattern: "x", searchPath: "/tmp", outputMode: "count" });
    expect(args).toContain("--count");
  });

  it("adds --line-number and --no-heading for content mode by default", () => {
    const args = buildRipgrepArgs({ pattern: "x", searchPath: "/tmp", outputMode: "content" });
    expect(args).toContain("--line-number");
    expect(args).toContain("--no-heading");
  });

  it("omits --line-number when lineNumbers is false", () => {
    const args = buildRipgrepArgs({ pattern: "x", searchPath: "/tmp", outputMode: "content", lineNumbers: false });
    expect(args).not.toContain("--line-number");
  });

  it("adds -i for case-insensitive search", () => {
    const args = buildRipgrepArgs({ pattern: "x", searchPath: "/tmp", outputMode: "content", caseSensitive: false });
    expect(args).toContain("-i");
  });

  it("does not add -i when caseSensitive is true", () => {
    const args = buildRipgrepArgs({ pattern: "x", searchPath: "/tmp", outputMode: "content", caseSensitive: true });
    expect(args).not.toContain("-i");
  });

  it("adds -U --multiline-dotall for multiline mode", () => {
    const args = buildRipgrepArgs({ pattern: "x", searchPath: "/tmp", outputMode: "content", multiline: true });
    expect(args).toContain("-U");
    expect(args).toContain("--multiline-dotall");
  });

  it("adds context flags", () => {
    const args = buildRipgrepArgs({ pattern: "x", searchPath: "/tmp", outputMode: "content", context: 3 });
    expect(args).toContain("-C");
    expect(args[args.indexOf("-C") + 1]).toBe("3");
  });

  it("adds before/after context flags", () => {
    const args = buildRipgrepArgs({ pattern: "x", searchPath: "/tmp", outputMode: "content", beforeContext: 2, afterContext: 1 });
    expect(args).toContain("-B");
    expect(args[args.indexOf("-B") + 1]).toBe("2");
    expect(args).toContain("-A");
    expect(args[args.indexOf("-A") + 1]).toBe("1");
  });

  it("adds --glob filter", () => {
    const args = buildRipgrepArgs({ pattern: "x", searchPath: "/tmp", outputMode: "content", glob: "*.ts" });
    expect(args).toContain("*.ts");
  });

  it("adds --type filter", () => {
    const args = buildRipgrepArgs({ pattern: "x", searchPath: "/tmp", outputMode: "content", type: "ts" });
    expect(args).toContain("--type");
    expect(args[args.indexOf("--type") + 1]).toBe("ts");
  });

  it("adds --max-count for non-count modes", () => {
    const args = buildRipgrepArgs({ pattern: "x", searchPath: "/tmp", outputMode: "content", maxResults: 25 });
    expect(args).toContain("--max-count");
    expect(args[args.indexOf("--max-count") + 1]).toBe("25");
  });

  it("does not add --max-count for count mode", () => {
    const args = buildRipgrepArgs({ pattern: "x", searchPath: "/tmp", outputMode: "count", maxResults: 25 });
    expect(args).not.toContain("--max-count");
  });

  it("places pattern and searchPath at the end", () => {
    const args = buildRipgrepArgs({ pattern: "mypattern", searchPath: "/my/path", outputMode: "content" });
    expect(args[args.length - 2]).toBe("mypattern");
    expect(args[args.length - 1]).toBe("/my/path");
  });
});

// ── applyPagination unit tests ────────────────────────────

describe("applyPagination", () => {
  const lines = ["a", "b", "c", "d", "e"];

  it("returns all lines when no limits set", () => {
    expect(applyPagination(lines)).toEqual(lines);
  });

  it("applies head_limit", () => {
    expect(applyPagination(lines, 3)).toEqual(["a", "b", "c"]);
  });

  it("applies offset", () => {
    expect(applyPagination(lines, undefined, 2)).toEqual(["c", "d", "e"]);
  });

  it("applies both offset and head_limit", () => {
    expect(applyPagination(lines, 2, 1)).toEqual(["b", "c"]);
  });

  it("returns empty array when offset exceeds length", () => {
    expect(applyPagination(lines, undefined, 10)).toEqual([]);
  });

  it("handles head_limit of 0 as no limit", () => {
    expect(applyPagination(lines, 0)).toEqual(lines);
  });
});

// ── buildGrepFallbackArgs unit tests ─────────────────────

describe("buildGrepFallbackArgs", () => {
  it("always includes --text flag (fixes BOM/binary silent failures in fallback)", () => {
    const args = buildGrepFallbackArgs("foo", "/tmp");
    expect(args).toContain("--text");
  });

  it("always includes -rn (recursive + line numbers)", () => {
    const args = buildGrepFallbackArgs("foo", "/tmp");
    expect(args[0]).toBe("-rn");
  });

  it("uses -n (not -rn) when searching a single file", () => {
    const args = buildGrepFallbackArgs("foo", "/tmp/file.ts", undefined, true);
    expect(args[0]).toBe("-n");
  });

  it("adds -i for case-insensitive search", () => {
    const args = buildGrepFallbackArgs("foo", "/tmp", false);
    expect(args).toContain("-i");
  });

  it("does not add -i when case_sensitive is true", () => {
    const args = buildGrepFallbackArgs("foo", "/tmp", true);
    expect(args).not.toContain("-i");
  });

  it("places pattern and searchPath at the end", () => {
    const args = buildGrepFallbackArgs("mypattern", "/my/path");
    expect(args[args.length - 2]).toBe("mypattern");
    expect(args[args.length - 1]).toBe("/my/path");
  });
});

// ── grep_search integration tests ────────────────────────

describe("grep_search tool", () => {
  let tmpDir: string;
  let mock: ReturnType<typeof makeMockServer>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "mcp-grep-test-"));
    mock = makeMockServer();
    registerGrep(mock.server);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("finds a pattern in a plain UTF-8 file", async () => {
    writeFileSync(join(tmpDir, "test.txt"), "hello world\nfoo bar\n");
    const result = await mock.call("grep_search", {
      pattern: "hello",
      path: tmpDir,
      output_mode: "content",
    });
    expect(result.content[0].text).toContain("hello");
    expect(result.content[0].text).not.toBe("(no matches)");
  });

  it("returns (no matches) when pattern is not present", async () => {
    writeFileSync(join(tmpDir, "test.txt"), "hello world\n");
    const result = await mock.call("grep_search", {
      pattern: "zzznomatch",
      path: tmpDir,
      output_mode: "content",
    });
    expect(result.content[0].text).toBe("(no matches)");
  });

  // Regression test for issue #196: BOM causes silent grep failure
  it("finds pattern in UTF-8 file with BOM (regression #196)", async () => {
    // Write file with UTF-8 BOM + content containing the search target
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    const content = Buffer.from("enqueueMessage\nmessageQueue\nprocessQueue\n");
    writeFileSync(join(tmpDir, "index.ts"), Buffer.concat([bom, content]));

    const result = await mock.call("grep_search", {
      pattern: "messageQueue",
      path: tmpDir,
      output_mode: "content",
    });
    expect(result.content[0].text).not.toBe("(no matches)");
    expect(result.content[0].text).toContain("messageQueue");
  });

  it("finds pattern in file with CRLF line endings", async () => {
    writeFileSync(join(tmpDir, "crlf.ts"), "foo\r\nenqueueMessage\r\nbar\r\n");
    const result = await mock.call("grep_search", {
      pattern: "enqueueMessage",
      path: tmpDir,
      output_mode: "content",
    });
    expect(result.content[0].text).not.toBe("(no matches)");
    expect(result.content[0].text).toContain("enqueueMessage");
  });

  it("files_with_matches mode returns file paths", async () => {
    writeFileSync(join(tmpDir, "a.txt"), "hello\n");
    writeFileSync(join(tmpDir, "b.txt"), "world\n");
    const result = await mock.call("grep_search", {
      pattern: "hello",
      path: tmpDir,
      output_mode: "files_with_matches",
    });
    expect(result.content[0].text).toContain("a.txt");
    expect(result.content[0].text).not.toContain("b.txt");
  });

  it("count mode returns match counts per file", async () => {
    writeFileSync(join(tmpDir, "c.txt"), "foo\nfoo\nbar\n");
    const result = await mock.call("grep_search", {
      pattern: "foo",
      path: tmpDir,
      output_mode: "count",
    });
    expect(result.content[0].text).toContain("2");
  });

  it("respects max_results limit", async () => {
    const lines = Array.from({ length: 20 }, (_, i) => `match${i}`).join("\n");
    writeFileSync(join(tmpDir, "many.txt"), lines);
    const result = await mock.call("grep_search", {
      pattern: "match",
      path: tmpDir,
      output_mode: "content",
      max_results: 3,
    });
    const matchCount = (result.content[0].text.match(/match\d/g) || []).length;
    expect(matchCount).toBeLessThanOrEqual(3);
  });

  it("applies head_limit pagination", async () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line${i}`).join("\n");
    writeFileSync(join(tmpDir, "paged.txt"), lines);
    const result = await mock.call("grep_search", {
      pattern: "line",
      path: tmpDir,
      output_mode: "content",
      head_limit: 2,
      max_results: 50,
    });
    const text = result.content[0].text;
    expect(text).toContain("total entries");
  });

  it("case-insensitive search matches regardless of case", async () => {
    writeFileSync(join(tmpDir, "case.txt"), "Hello World\n");
    const result = await mock.call("grep_search", {
      pattern: "hello",
      path: tmpDir,
      output_mode: "content",
      case_sensitive: false,
    });
    expect(result.content[0].text).toContain("Hello");
  });

  it("case-sensitive search does not match wrong case", async () => {
    writeFileSync(join(tmpDir, "case.txt"), "Hello World\n");
    const result = await mock.call("grep_search", {
      pattern: "hello",
      path: tmpDir,
      output_mode: "content",
      case_sensitive: true,
    });
    expect(result.content[0].text).toBe("(no matches)");
  });

  it("searching a single file (not a dir) returns matches", async () => {
    const file = join(tmpDir, "single.txt");
    writeFileSync(file, "alpha\nbeta\ngamma\n");
    const result = await mock.call("grep_search", {
      pattern: "beta",
      path: file,
      output_mode: "content",
    });
    expect(result.content[0].text).toContain("beta");
    expect(result.content[0].text).not.toBe("(no matches)");
  });

  // Honest-Response regression: an invalid regex makes every engine (rg, git-grep,
  // GNU grep) exit >=2. The engine's error text must NOT come back as match content
  // or as a false "(no matches)" — it must be flagged isError with the real reason.
  it("reports an engine error honestly instead of faking (no matches)", async () => {
    writeFileSync(join(tmpDir, "t.txt"), "hello\n");
    const result = await mock.call("grep_search", {
      pattern: "(unclosed",
      path: tmpDir,
      output_mode: "content",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("failed");
    expect(result.content[0].text).not.toBe("(no matches)");
  });

  it("uses the agentruntime root as default search path", async () => {
    const result = await mock.call("grep_search", {
      pattern: "zzznomatch_unique_xyz",
      output_mode: "content",
    });
    // Should not error — returns (no matches) or empty. The default path is the
    // agentruntime root; with the findstr fallback (no ripgrep) a full-tree scan
    // runs up to the tool's internal 30s cap, so allow more than the 5s default.
    // ripgrep makes this fast in normal environments.
    expect(result.content[0].type).toBe("text");
  }, 40_000);

  // ── token-funnel integration ────────────────────────────
  // grep.ts replaced its truncation block with funnel(output, "grep", …), gated
  // behind the same `output.length > MAX_OUTPUT` short-circuit as before, so
  // small/paginated results still pass through untouched (already covered by the
  // tests above, all of which stayed green after the change).

  it("compresses content-mode output over the budget, collapsing excess per-file matches", async () => {
    const lines = Array.from({ length: 3000 }, (_, i) => `unique match number ${i} with some padding text`);
    writeFileSync(join(tmpDir, "many-matches.txt"), lines.join("\n"));
    const result = await mock.call("grep_search", {
      pattern: "unique match",
      path: tmpDir,
      output_mode: "content",
      max_results: 3000, // bypass the tool's default 50-per-call cap so raw output clears MAX_OUTPUT
    });
    const text = result.content[0].text;
    expect(text.length).toBeLessThan(lines.join("\n").length);
    // funnelReversible emits a marker per dropped run (CCR path). grep.ts passes
    // labelMarkers: true, so the label is part of the contract here — for grep it names
    // the file the dropped run started in, which is what makes expanding a decision
    // rather than a guess across a multi-file result.
    expect(text).toMatch(/<<ccr:[0-9a-f]{64} \| [^<>]+>>/);
    expect(text).toContain("unique match number 0 ");
  });

  // Regression: default content-grep must be capped at 50 TOTAL lines, not 50-per-file.
  // Before the fix, max_results was falsy on default so no total cap was applied —
  // a multi-file tree with many matches could return 50×N lines, contradicting the
  // description's "default: 50" promise (Honest-Response violation).
  it("default content-grep across multiple files returns at most 50 total lines", async () => {
    // Create 5 files, each with 20 matching lines → 100 matches without a total cap.
    for (let f = 0; f < 5; f++) {
      const content = Array.from({ length: 20 }, (_, i) => `marker_line_${f}_${i}`).join("\n");
      writeFileSync(join(tmpDir, `file${f}.txt`), content);
    }
    const result = await mock.call("grep_search", {
      pattern: "marker_line",
      path: tmpDir,
      output_mode: "content",
      // max_results intentionally omitted — exercises the default cap
    });
    const text = result.content[0].text;
    const matchLines = text.split("\n").filter((l) => l.includes("marker_line"));
    expect(matchLines.length).toBeLessThanOrEqual(50);
  });

  it("leaves output under the budget untouched (no compression artifacts)", async () => {
    writeFileSync(join(tmpDir, "small.txt"), "alpha\nbeta\ngamma\n");
    const result = await mock.call("grep_search", {
      pattern: "alpha|beta|gamma",
      path: tmpDir,
      output_mode: "content",
    });
    const text = result.content[0].text;
    expect(text).not.toContain("⋯");
    expect(text).toContain("alpha");
    expect(text).toContain("beta");
    expect(text).toContain("gamma");
  });
});
