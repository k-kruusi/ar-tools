import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerBash, buildShellEnv } from "../tools/bash.js";

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

// ── buildShellEnv unit tests ──────────────────────────────
// Regression guard: on Windows the env var is keyed "Path", and a spread copy of
// process.env is case-sensitive — so reading env.PATH is undefined. Clobbering it
// would drop node/npm/etc from the child PATH (only git tools survive). These lock
// in "find the real key, prepend, no duplicate".

describe("buildShellEnv", () => {
  it("prepends to a lowercase 'Path' key (Windows) without dropping it or duplicating", () => {
    const env = buildShellEnv({ Path: "C:\\node;C:\\sys" }, "G:\\git\\usr\\bin");
    expect(env.Path).toBe("G:\\git\\usr\\bin;C:\\node;C:\\sys");
    expect(env.PATH).toBeUndefined(); // no duplicate uppercase key created
  });

  it("prepends to an uppercase PATH key", () => {
    const env = buildShellEnv({ PATH: "/usr/bin" }, "/git/usr/bin");
    expect(env.PATH).toBe("/git/usr/bin;/usr/bin");
  });

  it("leaves env unchanged when pathPrepend is null (non-Windows / cmd.exe)", () => {
    const env = buildShellEnv({ PATH: "/usr/bin" }, null);
    expect(env.PATH).toBe("/usr/bin");
  });
});

describe("run_command tool", () => {
  let mock: ReturnType<typeof makeMockServer>;

  beforeEach(() => {
    mock = makeMockServer();
    registerBash(mock.server);
  });

  it("executes a simple command and returns stdout", async () => {
    const result = await mock.call("run_command", { command: "echo hello" });
    expect(result.content[0].text).toContain("hello");
    expect(result.isError).toBeUndefined();
  });

  it("returns stderr in output when command writes to stderr", async () => {
    const result = await mock.call("run_command", { command: "echo error >&2" });
    expect(result.content[0].text).toContain("error");
  });

  it("marks result as error when exit code is non-zero", async () => {
    const result = await mock.call("run_command", { command: "exit 1" });
    expect(result.isError).toBe(true);
  });

  it("includes exit code annotation for non-zero exits", async () => {
    const result = await mock.call("run_command", { command: "exit 2" });
    expect(result.content[0].text).toContain("exit code: 2");
  });

  it("returns (no output) for commands with no stdout/stderr", async () => {
    const result = await mock.call("run_command", { command: "true" });
    expect(result.content[0].text).toBe("(no output)");
    expect(result.isError).toBeUndefined();
  });

  it("respects cwd option", async () => {
    // Use a real temp dir (cross-platform) — the old test hardcoded "/tmp",
    // which doesn't exist on Windows and made spawn fail with ENOENT.
    const dir = mkdtempSync(join(tmpdir(), "mcp-bash-cwd-"));
    try {
      const result = await mock.call("run_command", { command: "pwd", cwd: dir });
      // `pwd` prints the working dir; git bash on Windows uses /c/... form, so
      // assert the unique final path segment is present rather than exact match.
      const leaf = dir.split(/[/\\]/).pop()!;
      expect(result.content[0].text).toContain(leaf);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves the system PATH (node available, not just git tools)", async () => {
    // Regression for the PATH-clobber bug: under git bash, node/npm/etc must
    // still resolve. (vitest runs under node, so node is on PATH here.)
    const result = await mock.call("run_command", { command: "node -v" });
    expect(result.content[0].text).toMatch(/v\d+\./);
    expect(result.isError).toBeUndefined();
  });

  it("captures multiline output", async () => {
    const result = await mock.call("run_command", { command: "printf 'line1\\nline2\\nline3\\n'" });
    const text = result.content[0].text;
    expect(text).toContain("line1");
    expect(text).toContain("line2");
    expect(text).toContain("line3");
  });

  it("handles commands with both stdout and stderr", async () => {
    const result = await mock.call("run_command", { command: "echo out; echo err >&2; exit 0" });
    const text = result.content[0].text;
    expect(text).toContain("out");
    expect(text).toContain("err");
  });

  it("flags a timeout as an error, not a clean-looking success", async () => {
    const result = await mock.call("run_command", { command: "sleep 2", timeout_ms: 200 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/timed out|killed/i);
  });

  it("clamps timeout_ms to max 600000", async () => {
    // Just verify it doesn't error with a large timeout (we don't actually wait)
    const result = await mock.call("run_command", { command: "echo ok", timeout_ms: 9_999_999 });
    expect(result.content[0].text).toContain("ok");
  });

  // ── DEFAULT_TIMEOUT is intentionally not exported (test behavior, not the
  // constant) — spy on the scheduling call itself to verify the actual ms
  // value used, without waiting out a real 5-minute timer.
  describe("timeout scheduling", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("schedules the kill timer at 300000ms (5min) when timeout_ms is omitted", async () => {
      const spy = vi.spyOn(globalThis, "setTimeout");
      await mock.call("run_command", { command: "echo hi" });
      expect(spy.mock.calls.some((call) => call[1] === 300_000)).toBe(true);
    });

    it("clamps an oversized timeout_ms to 600000ms before scheduling the timer", async () => {
      const spy = vi.spyOn(globalThis, "setTimeout");
      await mock.call("run_command", { command: "echo hi", timeout_ms: 999_999 });
      expect(spy.mock.calls.some((call) => call[1] === 600_000)).toBe(true);
    });

    it("schedules the kill timer at the caller-supplied timeout_ms when under the ceiling", async () => {
      const spy = vi.spyOn(globalThis, "setTimeout");
      await mock.call("run_command", { command: "echo hi", timeout_ms: 150_000 });
      expect(spy.mock.calls.some((call) => call[1] === 150_000)).toBe(true);
    });
  });
});

// ── token-funnel integration ──────────────────────────────
// bash.ts replaced its old truncate() with funnel(stdout/stderr, classifyCommand(command), …).
// These exercise that wiring through the real registered tool handler — not the
// funnel()/classifyCommand() library, which has its own exhaustive suite in
// dependencies/token-funnel.

describe("run_command tool: output compression (token-funnel)", () => {
  let mock: ReturnType<typeof makeMockServer>;

  beforeEach(() => {
    mock = makeMockServer();
    registerBash(mock.server);
  });

  it("compresses stdout larger than the output budget", async () => {
    const script = "let s='';for(let i=0;i<9000;i++)s+='line '+i+'\\n';process.stdout.write(s)";
    const result = await mock.call("run_command", { command: `node -e "${script}"` });
    const text = result.content[0].text;
    expect(text.length).toBeLessThan(80_000); // raw stdout is ~89KB
    expect(text).toContain("line 0");
    // funnelReversible emits a marker for each dropped run (CCR path). bash.ts passes
    // labelMarkers: true, so assert the LABELLED grammar — a bare-only regex silently
    // stops matching the moment a caller opts in, which is how this assertion broke.
    expect(text).toMatch(/<<ccr:[0-9a-f]{64} \| [^<>]+>>/);
  });

  it("never drops an Error: line from stdout even when it's buried in far-over-budget output", async () => {
    const script =
      "let s='';for(let i=0;i<4000;i++)s+='padding line '+i+'\\n';" +
      "s+='Error: something broke\\n';" +
      "for(let i=0;i<4000;i++)s+='more padding '+i+'\\n';" +
      "process.stdout.write(s)";
    const result = await mock.call("run_command", { command: `node -e "${script}"` });
    expect(result.content[0].text).toContain("Error: something broke");
  });

  it("uses classifyCommand's category-specific compression, not the generic fallback", async () => {
    // classifyCommand routes to the test-output profile. Category-specific rules
    // still apply (boilerplate classification, priority ordering); the placeholder
    // text is now a <<ccr:HASH>> marker rather than a profile-specific string,
    // but the output IS shorter than the input and the head line is preserved.
    const script = "let s='';for(let i=0;i<3000;i++)s+='\\u2713 passing test '+i+'\\n';process.stdout.write(s)";
    const command = `node -e "${script}" # looks like npm test output`;
    const result = await mock.call("run_command", { command });
    const text = result.content[0].text;
    expect(text.length).toBeLessThan(3000 * 25); // compressed well below raw size
    expect(text).toContain("✓ passing test 0");
    expect(text).toMatch(/<<ccr:[0-9a-f]{64} \| [^<>]+>>/); // labelled CCR marker for dropped runs
  });

  it("still appends the exit code annotation after stderr is compressed", async () => {
    const script = "let s='';for(let i=0;i<9000;i++)s+='padding '+i+'\\n';process.stderr.write(s);process.exit(3)";
    const result = await mock.call("run_command", { command: `node -e "${script}"` });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("[exit code: 3]");
    expect(result.content[0].text).toContain("[stderr]");
  });
});
