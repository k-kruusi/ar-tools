import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { spawn } from "node:child_process";
import { statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { funnelReversible } from "@agentruntime/token-funnel";
import { ccrStash } from "../lib/ccr-store.js";
import { scrubToolOutput } from "../scrub-util.js";
import { normalizePath, agentruntimeRoot, gitTool, gitignoreDirs } from "../utils.js";
import { scentHint } from "../lib/scent-hint.js";
import { skillHint } from "../lib/skill-hint.js";

const MAX_OUTPUT = 50_000;
const GREP_TIMEOUT = 30_000;

interface GrepResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

function spawnTool(
  cmd: string,
  args: string[],
  timeoutMs = GREP_TIMEOUT,
): Promise<GrepResult> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    // Keep stdout and stderr SEPARATE. Merging them (the old behaviour) meant an
    // engine's diagnostic — "regex parse error", "No such file" — came back as if
    // it were match content, with no way for the caller to tell a result from an
    // error. That is exactly the Honest-Response violation grep_search exists to
    // prevent. stdout is the result; stderr is the reason; the exit code says which
    // one is authoritative.
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    proc.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    proc.stderr.on("data", (chunk: Buffer) => err.push(chunk));

    const done = (exitCode: number | null) =>
      resolve({
        stdout: Buffer.concat(out).toString("utf-8"),
        stderr: Buffer.concat(err).toString("utf-8"),
        exitCode,
      });

    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      done(null);
    }, timeoutMs);

    proc.on("close", (code) => {
      clearTimeout(timer);
      done(code);
    });

    proc.on("error", () => {
      clearTimeout(timer);
      done(-1);
    });
  });
}

export function buildRipgrepArgs(opts: {
  pattern: string;
  searchPath: string;
  outputMode: string;
  glob?: string;
  type?: string;
  context?: number;
  beforeContext?: number;
  afterContext?: number;
  maxResults?: number;
  caseSensitive?: boolean;
  multiline?: boolean;
  lineNumbers?: boolean;
}): string[] {
  const args: string[] = [
    "--color", "never",
    "--encoding", "auto",  // handle BOM, UTF-16, and mixed line endings (fixes #196)
    "--glob", "!node_modules/**",
    "--glob", "!.git/**",
  ];

  // Output mode
  if (opts.outputMode === "files_with_matches") {
    args.push("--files-with-matches");
  } else if (opts.outputMode === "count") {
    args.push("--count");
  } else {
    // content mode — show line numbers by default
    if (opts.lineNumbers !== false) args.push("--line-number");
    args.push("--no-heading");
  }

  // Context (only relevant for content mode)
  if (opts.outputMode === "content") {
    if (opts.context) args.push("-C", String(opts.context));
    if (opts.beforeContext) args.push("-B", String(opts.beforeContext));
    if (opts.afterContext) args.push("-A", String(opts.afterContext));
  }

  // Filtering
  if (opts.glob) args.push("--glob", opts.glob);
  if (opts.type) args.push("--type", opts.type);
  if (opts.caseSensitive === false) args.push("-i");

  // Multiline
  if (opts.multiline) {
    args.push("-U", "--multiline-dotall");
  }

  // Max results (per-file for count, total for others)
  if (opts.outputMode !== "count" && opts.maxResults) {
    args.push("--max-count", String(opts.maxResults));
  }

  args.push(opts.pattern, opts.searchPath);
  return args;
}

export function applyPagination(lines: string[], headLimit?: number, offset?: number): string[] {
  let result = lines;
  if (offset && offset > 0) {
    result = result.slice(offset);
  }
  if (headLimit && headLimit > 0) {
    result = result.slice(0, headLimit);
  }
  return result;
}

/**
 * findstr's /R regex is severely limited — it supports `. * [] ^ $ \< \>` and
 * little else. Common PCRE features (alternation, quantifiers, grouping, class
 * escapes) silently fail to match because findstr treats them as literals, which
 * turns a real query into a false "(no matches)". We detect these so grep_search
 * can warn honestly when the ONLY available engine is findstr (no ripgrep, no
 * Git-bundled GNU grep).
 */
export function findstrUnsupported(pattern: string): string[] {
  const checks: Array<[RegExp, string]> = [
    [/\|/, "| (alternation)"],
    [/\+/, "+ (one-or-more)"],
    [/\?/, "? (optional)"],
    [/[{}]/, "{n} (repetition)"],
    [/[()]/, "() (grouping)"],
    [/\\[bBdDwWsS]/, "\\d \\w \\s \\b (classes/anchors)"],
  ];
  return checks.filter(([re]) => re.test(pattern)).map(([, label]) => label);
}

/**
 * Run a Git-bundled GNU grep by full path (Git for Windows ships grep under
 * usr/bin even when it isn't on PATH). Unlike findstr, GNU grep does real regex
 * (-E alternation, quantifiers) and excludes node_modules/.git at SCAN time, so
 * it's both correct and fast — the preferred fallback when ripgrep is absent.
 */
function runGitGrep(
  grepExe: string,
  pattern: string,
  searchPath: string,
  caseSensitive?: boolean,
  isFile = false,
): Promise<GrepResult> {
  const args = [
    isFile ? "-nE" : "-rnE",
    "--text",
    ...(caseSensitive === false ? ["-i"] : []),
    // Skip gitignored territory (dist/, data/, projects/, checkpoints, …) — ripgrep
    // does this for free; plain recursive grep would otherwise crawl it and time out.
    ...(isFile ? [] : gitignoreDirs().map((d) => `--exclude-dir=${d}`)),
    pattern,
    searchPath,
  ];
  return spawnTool(grepExe, args);
}

function runFindstrFallback(
  pattern: string,
  searchPath: string,
  caseSensitive?: boolean,
  isFile = false,
): Promise<GrepResult> {
  // findstr's `dir\*` target only works for directories; for a single file,
  // pass the file path directly (no /S recursion, no \* glob) — otherwise
  // `file\*` matches nothing and we'd report a false "(no matches)".
  const args = [
    ...(isFile ? [] : ["/S"]),
    ...(caseSensitive === false ? ["/I"] : []),
    "/N", "/R", `/C:${pattern}`, isFile ? searchPath : `${searchPath}\\*`,
  ];
  return spawnTool("findstr", args);
}

export function buildGrepFallbackArgs(
  pattern: string,
  searchPath: string,
  caseSensitive?: boolean,
  isFile = false,
  excludeDirs: string[] = [],
): string[] {
  // -E: extended regex so alternation/grouping work (POSIX grep BRE doesn't).
  return [
    isFile ? "-n" : "-rn", "-E", "--text",
    ...(caseSensitive === false ? ["-i"] : []),
    ...(isFile ? [] : excludeDirs.map((d) => `--exclude-dir=${d}`)),
    pattern, searchPath,
  ];
}

function runGrepFallback(
  pattern: string,
  searchPath: string,
  caseSensitive?: boolean,
  isFile = false,
): Promise<GrepResult> {
  return spawnTool("grep", buildGrepFallbackArgs(pattern, searchPath, caseSensitive, isFile, gitignoreDirs()));
}

/**
 * Resolve the ripgrep binary. Prefer the repo-bundled rg (.tools-bin/rg.exe) —
 * PATH-independent, so it works regardless of what PATH the shared tools server
 * inherited (the supervisor captures PATH at startup, so a system rg install
 * isn't visible to a restarted cartridge). Falls back to "rg" on PATH; if neither
 * resolves, the spawn errors and grep_search falls back to GNU grep / findstr.
 * Run scripts/fetch-ripgrep.sh to populate .tools-bin on a new machine.
 */
function ripgrepPath(): string {
  const bundled = join(agentruntimeRoot(), ".tools-bin", process.platform === "win32" ? "rg.exe" : "rg");
  if (existsSync(bundled)) return bundled;
  return "rg";
}

export function registerGrep(server: McpServer): void {
  server.tool(
    "grep_search",
    "Search file contents by regex pattern. Uses ripgrep, falling back to Git-bundled GNU grep (full regex) or findstr. Supports output modes (content, files_with_matches, count), context lines, multiline patterns, and pagination.",
    {
      pattern: z.string().describe("Regex pattern to search for"),
      path: z.string().optional().describe("File or directory to search — absolute, or relative to the agentruntime root. Defaults to the agentruntime root."),
      output_mode: z.enum(["content", "files_with_matches", "count"]).optional()
        .describe("Output mode: 'content' shows matching lines, 'files_with_matches' shows file paths only, 'count' shows match counts per file (default: files_with_matches)"),
      glob: z.string().optional().describe("File pattern filter (e.g. '*.ts', '*.{js,jsx}')"),
      type: z.string().optional().describe("File type filter — ripgrep built-in types (e.g. 'js', 'py', 'rust', 'ts'). More efficient than glob for standard types."),
      context: z.number().optional().describe("Lines of context before and after each match (content mode only)"),
      before_context: z.number().optional().describe("Lines of context before each match (content mode only)"),
      after_context: z.number().optional().describe("Lines of context after each match (content mode only)"),
      max_results: z.number().optional().describe("In content mode: max matching lines returned in total (default: 50; enforced post-search). Also passed to ripgrep as --max-count (per-file). Other modes are not total-capped by this param — use head_limit for pagination."),
      case_sensitive: z.boolean().optional().describe("Case-sensitive search (default: true)"),
      multiline: z.boolean().optional().describe("Enable multiline mode — dot matches newlines, patterns can span lines (default: false)"),
      head_limit: z.number().optional().describe("Limit output to first N lines/entries (like | head -N)"),
      offset: z.number().optional().describe("Skip first N lines/entries before applying head_limit"),
      line_numbers: z.boolean().optional().describe("Show line numbers in content mode (default: true)"),
    },
    async ({
      pattern, path, output_mode, glob: globFilter, type: typeFilter,
      context, before_context, after_context, max_results,
      case_sensitive, multiline, head_limit, offset, line_numbers,
    }) => {
      const searchPath = path ? normalizePath(path) : agentruntimeRoot();
      const mode = output_mode || "files_with_matches";

      // Is the target a single file? Affects fallback arg construction (findstr
      // can't take a `dir\*` glob on a file; grep needs -n not -rn).
      let isFile = false;
      try { isFile = statSync(searchPath).isFile(); } catch { /* missing path — let the search tool surface it */ }

      // Try ripgrep first
      const rgArgs = buildRipgrepArgs({
        pattern,
        searchPath,
        outputMode: mode,
        glob: globFilter,
        type: typeFilter,
        context,
        beforeContext: before_context,
        afterContext: after_context,
        maxResults: max_results || 50,
        caseSensitive: case_sensitive,
        multiline,
        lineNumbers: line_numbers,
      });

      let result = await spawnTool(ripgrepPath(), rgArgs);
      let fellBackToFindstr = false;

      // Fallback if rg not found (exit code -1 = spawn error). Prefer Git-bundled
      // GNU grep (real regex, fast) over findstr; use findstr only as last resort.
      if (result.exitCode === -1) {
        const gitGrep = gitTool("grep.exe"); // null on non-Windows / if Git absent
        if (gitGrep) {
          result = await runGitGrep(gitGrep, pattern, searchPath, case_sensitive, isFile);
        } else if (process.platform === "win32") {
          result = await runFindstrFallback(pattern, searchPath, case_sensitive, isFile);
          fellBackToFindstr = true;
        } else {
          result = await runGrepFallback(pattern, searchPath, case_sensitive, isFile);
        }

        // Filter out gitignored territory (findstr has no --exclude-dir; harmless for
        // git-grep/GNU-grep, which already excluded them at scan time). Derived from
        // the same .gitignore-backed list used for --exclude-dir, so the fallbacks
        // agree with ripgrep on what's out of scope.
        if (result.stdout) {
          const escaped = gitignoreDirs().map((d) => d.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
          const excludePattern = new RegExp(`[/\\\\](${escaped})[/\\\\]`);
          result.stdout = result.stdout
            .split("\n")
            .filter((line) => !excludePattern.test(line))
            .join("\n");
        }

        // Fallback tools don't support output modes — simulate files_with_matches
        if (mode === "files_with_matches" && result.stdout) {
          const files = new Set<string>();
          for (const line of result.stdout.split("\n")) {
            const match = line.match(/^(.+?):\d+:/);
            if (match) files.add(match[1]);
          }
          result.stdout = [...files].join("\n");
        } else if (mode === "count" && result.stdout) {
          const counts = new Map<string, number>();
          for (const line of result.stdout.split("\n")) {
            const match = line.match(/^(.+?):\d+:/);
            if (match) counts.set(match[1], (counts.get(match[1]) || 0) + 1);
          }
          result.stdout = [...counts.entries()].map(([f, c]) => `${f}:${c}`).join("\n");
        }
      }

      // Honest engine-error guard. rg / grep / git-grep / findstr share one
      // convention: exit 0 = match, 1 = no match, >=2 = a real failure (bad regex,
      // unreadable path, …). On a real failure, empty stdout is NOT a confirmed
      // "no match", and the reason lives in stderr — which we now keep separate so
      // it can't masquerade as match content. Surface it as isError. (exit -1 is
      // our spawn-not-found sentinel, already resolved by the fallback chain above.)
      //
      // Exception: exit >=2 WITH usable stdout means the engine found matches but
      // also hit IO-level errors on side paths (dangling junctions, locked or
      // unreadable files). One bad path shouldn't hard-fail a whole tree search —
      // return the matches, labeled PARTIAL, with the error detail attached.
      let engineWarning = "";
      if (result.exitCode !== null && result.exitCode > 1) {
        const diag = (result.stderr.trim() || result.stdout.trim()).slice(0, 2000);
        if (!result.stdout.trim()) {
          return {
            content: [{
              type: "text" as const,
              text:
                `grep_search failed (exit ${result.exitCode}) — NOT a confirmed "no match". ` +
                (diag || "The search engine reported an error with no detail."),
            }],
            isError: true,
          };
        }
        engineWarning =
          `WARNING: search engine reported errors (exit ${result.exitCode}) — results are ` +
          `PARTIAL (some paths unreadable). Errors: ${result.stderr.trim().slice(0, 500)}`;
      }

      // A timed-out search was killed mid-scan: whatever we have is partial, so say
      // so rather than presenting it (or "(no matches)") as a complete result.
      if (result.exitCode === null) {
        const partial = result.stdout.trim().slice(0, MAX_OUTPUT);
        return {
          content: [{
            type: "text" as const,
            text:
              `grep_search timed out after ${GREP_TIMEOUT}ms — results are PARTIAL and may ` +
              `miss matches; narrow the path or pattern.` + (partial ? `\n\n${partial}` : ""),
          }],
          isError: true,
        };
      }

      let output = result.stdout.trim();

      // Enforce max_results as a total cap in content mode. --max-count is per-file
      // in ripgrep, and fallback tools don't support it at all, so we always
      // post-process to guarantee the total result count is bounded.
      // effectiveMax applies the default (50) when max_results is omitted, so the
      // cap is ALWAYS enforced — matching the description's "default: 50" promise.
      const effectiveMax = max_results ?? 50;
      if (mode === "content" && output) {
        const lines = output.split("\n");
        if (lines.length > effectiveMax) {
          output = lines.slice(0, effectiveMax).join("\n");
        }
      }

      // Apply pagination
      if (head_limit || offset) {
        const lines = output.split("\n");
        const paginated = applyPagination(lines, head_limit, offset);
        const totalLines = lines.length;
        output = paginated.join("\n");
        if (paginated.length < totalLines) {
          output += `\n\n(${totalLines} total entries — showing ${offset ? `offset ${offset}, ` : ""}${paginated.length} entries)`;
        }
      }

      // Scrub secrets BEFORE compression (spec: scrub then compress).
      const { text: scrubbed, note: scrubNote } = scrubToolOutput(output);
      output = scrubbed;

      // Compress if still too large — short-circuited so already-paginated
      // small results pass through untouched.
      if (output.length > MAX_OUTPUT) {
        // labelMarkers: for grep especially, the label names the file the dropped run
        // started in — which is the one fact that makes "expand this span" a decision
        // rather than a guess across a multi-file result.
        const funneled = funnelReversible(output, "grep", { maxChars: MAX_OUTPUT, labelMarkers: true });
        output = funneled.text;
        ccrStash(funneled.stashed);
      }

      // Honest-failure guard: only reachable when findstr was the ONLY engine
      // available (no ripgrep AND no Git-bundled grep). An empty result for a
      // pattern findstr can't evaluate is not a real "no match" — say so.
      if (!output && fellBackToFindstr) {
        const unsupported = findstrUnsupported(pattern);
        if (unsupported.length > 0) {
          return {
            content: [{
              type: "text" as const,
              text:
                `grep_search could not evaluate this pattern. Neither ripgrep (rg) nor a ` +
                `Git-bundled grep is available, and the findstr fallback does not support: ` +
                `${unsupported.join(", ")}. The empty result is UNRELIABLE — not a confirmed ` +
                `"no match". Fixes: install ripgrep (rg) or Git for Windows; or rewrite using ` +
                `findstr-compatible syntax (literal / . * [] ^ $ only).`,
            }],
            isError: true,
          };
        }
      }

      // Ambient orientation (advisory, once per area per session): the first
      // search touching an area carries the scent trail's one-liner for it,
      // so the resident's knowledge arrives at the moment of need.
      // (lines are `path`, `path:count`, or `path:line:text` — strip from the
      // first colon that isn't a Windows drive separator)
      const hitPaths = output
        ? output.split("\n").filter(Boolean).map((l) => l.match(/^((?:[A-Za-z]:)?[^:\n]*)/)?.[1] ?? "")
        : [];
      const hint = skillHint(hitPaths) + scentHint(hitPaths);

      const body = (engineWarning ? engineWarning + "\n\n" : "") + hint + (output || "(no matches)");
      return {
        content: [{ type: "text" as const, text: scrubNote ? body + "\n" + scrubNote : body }],
      };
    },
  );
}
