import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readFileSync, statSync, appendFileSync, mkdirSync } from "node:fs";
import { recordRead, planeBanner } from "../lib/edit-plane.js";
import { join, dirname } from "node:path";
import { z } from "zod";
import { funnel } from "@agentruntime/token-funnel";
import { scrubToolOutput } from "../scrub-util.js";
import { normalizePath, agentruntimeRoot } from "../utils.js";
import {
  init as tsInit,
  getOutline,
  formatOutline,
  detectLanguage,
} from "@agentruntime/tree-sitter";

const MAX_OUTPUT = 50_000;
const MAX_LINE_LENGTH = 2000;

// Map-before-bytes for prose: a large markdown file defaults to its frontmatter
// (the routing metadata — name, description, scent) plus a heading outline with
// line ranges, the same contract the tree-sitter outline gives code. Small files
// aren't worth the indirection and read whole.
const MD_OUTLINE_MIN_LINES = 300;

/** Heading outline for a markdown file: frontmatter verbatim (bounded), then
 *  `start-end │ ## Title` per heading. Exported for tests. */
export function markdownOutline(filePath: string, allLines: string[]): string {
  const parts: string[] = [`${filePath} (${allLines.length} lines)`];

  // Frontmatter (--- fenced at top, possibly after an HTML-comment scent block).
  let i = 0;
  while (i < allLines.length && allLines[i].trim() === "") i++;
  if (allLines[i]?.trim().startsWith("<!--")) {
    const close = allLines.findIndex((l, n) => n >= i && l.includes("-->"));
    if (close !== -1 && close - i < 40) {
      parts.push(`(scent/comment block: lines ${i + 1}-${close + 1})`);
      i = close + 1;
      while (i < allLines.length && allLines[i].trim() === "") i++;
    }
  }
  if (allLines[i]?.trim() === "---") {
    const close = allLines.findIndex((l, n) => n > i && l.trim() === "---");
    if (close !== -1 && close - i < 40) {
      parts.push(...allLines.slice(i, close + 1));
      i = close + 1;
    }
  }

  const headings: string[] = [];
  const headingRe = /^(#{1,4})\s+\S/;
  let fence = false;
  const starts: Array<{ line: number; text: string; level: number }> = [];
  for (let n = i; n < allLines.length; n++) {
    const l = allLines[n];
    if (/^(```|~~~)/.test(l.trim())) fence = !fence;
    if (fence) continue;
    const m = headingRe.exec(l);
    if (m) starts.push({ line: n + 1, text: l.trim(), level: m[1].length });
  }
  for (let k = 0; k < starts.length; k++) {
    const end = k + 1 < starts.length ? starts[k + 1].line - 1 : allLines.length;
    headings.push(`${String(starts[k].line).padStart(6)}-${end} │ ${starts[k].text}`);
  }
  if (headings.length) parts.push("", ...headings);
  return parts.join("\n");
}

// ── Outline-coverage instrumentation ─────────────────────────────────────────
// Hypothesis under test (Kevin, 2026-07-21): a model handed an outline will
// satisfice — infer the unread sections from their headings and never follow
// up. This measures it instead of arguing it: every outline return and every
// subsequent ranged read of the same file this process is appended to a JSONL
// ledger. Coverage ratio = followups / outlines, computable per kind and per
// runtime with data_select. Advisory (never breaks a read), but loud once on
// stderr if the ledger can't be written — silent-broken instrumentation is how
// the scent-hint break hid for 6 days.
const COVERAGE_LOG = join(agentruntimeRoot(), "logs", "read-coverage.jsonl");
const outlined = new Map<string, { kind: "code" | "md"; followedUp: boolean }>();
let warnedCoverageLog = false;
function coverageEvent(event: "outline" | "followup", file: string, kind: "code" | "md"): void {
  try {
    mkdirSync(dirname(COVERAGE_LOG), { recursive: true });
    appendFileSync(
      COVERAGE_LOG,
      JSON.stringify({ t: new Date().toISOString(), pid: process.pid, event, kind, file }) + "\n",
    );
  } catch (e) {
    if (!warnedCoverageLog) {
      warnedCoverageLog = true;
      console.error(`[ar-tools] read-coverage ledger unwritable (${e instanceof Error ? e.message : e}) — outline-satisficing data is NOT being collected`);
    }
  }
}
export function noteOutline(file: string, kind: "code" | "md"): void {
  outlined.set(file, { kind, followedUp: false });
  coverageEvent("outline", file, kind);
}
/** Also called by read_symbol/read_symbols — for code files the natural
 *  follow-up after an outline is a symbol read, not a ranged read. */
export function noteRangedRead(file: string): void {
  const o = outlined.get(file);
  if (!o || o.followedUp) return; // only the FIRST followup counts — one bit per outline
  o.followedUp = true;
  coverageEvent("followup", file, o.kind);
}

// Doorbell (once per server process, ≈ once per agent session): a large
// .json/.jsonl/.log read gets one line pointing at the data-side map tools.
// Advisory decoration — never an error, never latency.
const DATA_HINT_MIN_BYTES = 100_000;
let dataHintRung = false;
function dataToolsHint(filePath: string, bytes: number): string {
  if (dataHintRung || bytes < DATA_HINT_MIN_BYTES || !/\.(json|jsonl|log)$/i.test(filePath)) return "";
  dataHintRung = true;
  return `[hint] large data file (${Math.round(bytes / 1024)} KB) — data_shape maps its field structure and data_select projects just the fields you name, at a fraction of these tokens. (once-per-session note)\n\n`;
}

function isBinary(buffer: Buffer): boolean {
  for (let i = 0; i < Math.min(buffer.length, 8000); i++) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

export function registerRead(server: McpServer): void {
  server.tool(
    "read_file",
    "Read a file. Without offset/limit: code files (.ts, .js, .py) return a structural outline with line ranges, and large markdown files return frontmatter + a heading outline — use offset/limit to read specific sections, or raw=true for the full file.",
    {
      file_path: z.string().describe("Path to the file to read — absolute, or relative to the agentruntime root"),
      offset: z.number().optional().describe("Line number to start from (1-based)"),
      limit: z.number().optional().describe("Max lines to return"),
      raw: z.boolean().optional().describe("Return full file content even for code files (skip outline)"),
    },
    async ({ file_path: rawPath, offset, limit, raw }) => {
      const file_path = normalizePath(rawPath);
      try {
        const stat = statSync(file_path);
        if (stat.isDirectory()) {
          return {
            content: [{ type: "text" as const, text: `Error: "${file_path}" is a directory, not a file.` }],
            isError: true,
          };
        }

        const rawBuf = readFileSync(file_path);
        if (isBinary(rawBuf)) {
          return {
            content: [{ type: "text" as const, text: `Binary file (${stat.size} bytes). Cannot display contents.` }],
          };
        }

        const content = rawBuf.toString("utf-8");
        if (!content) {
          return { content: [{ type: "text" as const, text: "(empty file)" }] };
        }

        // The read is the half that makes contention detectable: remember the
        // exact bytes this agent saw, so a write minutes later can tell whether
        // the tree moved underneath it. And surface anyone else's in-flight edit
        // NOW — before this agent reasons against a file someone is rewriting.
        recordRead(file_path, content);
        const planeNote = planeBanner(file_path);

        const allLines = content.split("\n");
        const hasRange = offset !== undefined || limit !== undefined;

        if (!hasRange && !raw && detectLanguage(file_path)) {
          try {
            await tsInit();
            const symbols = await getOutline(file_path);
            const formatted = formatOutline(file_path, symbols, allLines.length);
            noteOutline(file_path, "code");
            return {
              content: [{
                type: "text" as const,
                text: planeNote + formatted +
                  `\n\n(${allLines.length} lines total — use offset/limit to read specific line ranges, or raw=true for the full file)`,
              }],
            };
          } catch {
            // fall through to raw read
          }
        }

        if (!hasRange && !raw && /\.(md|mdx)$/i.test(file_path) && allLines.length > MD_OUTLINE_MIN_LINES) {
          noteOutline(file_path, "md");
          return {
            content: [{
              type: "text" as const,
              text: markdownOutline(file_path, allLines) +
                `\n\n(${allLines.length} lines total — use offset/limit to read specific sections, or raw=true for the full file)`,
            }],
          };
        }

        if (hasRange || raw) noteRangedRead(file_path);

        const startLine = Math.max(1, offset || 1);
        const maxLines = limit || 2000;
        const lines = allLines.slice(startLine - 1, startLine - 1 + maxLines);

        const numbered = lines.map((line, i) => {
          const lineNum = startLine + i;
          const truncated = line.length > MAX_LINE_LENGTH
            ? line.slice(0, MAX_LINE_LENGTH) + "..."
            : line;
          return `${String(lineNum).padStart(6)} │ ${truncated}`;
        });

        let output = dataToolsHint(file_path, stat.size) + numbered.join("\n");

        // Scrub secrets BEFORE compression (spec: scrub then compress).
        const { text: scrubbed, note: scrubNote } = scrubToolOutput(output);
        output = scrubbed;

        if (output.length > MAX_OUTPUT) {
          output = funnel(output, "file-read", { maxChars: MAX_OUTPUT });
        }

        if (allLines.length > startLine - 1 + maxLines) {
          output += `\n\n(${allLines.length} total lines — showing ${startLine} to ${startLine + lines.length - 1})`;
        }
        if (scrubNote) output += `\n\n${scrubNote}`;

        return { content: [{ type: "text" as const, text: planeNote + (output || "(empty file)") }] };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    },
  );
}
