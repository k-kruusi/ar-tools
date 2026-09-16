import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { normalizePath } from "../utils.js";
import { planeWrite } from "../lib/edit-plane.js";
import { detectRipple, rippleBaselineMissing } from "../lib/structural-diff.js";
import { scanHiddenCodepoints, formatHiddenCharWarning } from "../lib/hidden-chars.js";

/** Numbered preview matching read_file's ` NNNNNN │ text` convention, capped for large spans. */
function previewSpan(lines: string[], startLine: number): string {
  const CAP = 4;
  const fmt = (line: string, num: number) => `${String(num).padStart(6)} │ ${line}`;
  if (lines.length <= CAP * 2) {
    return lines.map((l, i) => fmt(l, startLine + i)).join("\n");
  }
  const head = lines.slice(0, CAP).map((l, i) => fmt(l, startLine + i));
  const tail = lines.slice(-CAP).map((l, i) => fmt(l, startLine + lines.length - CAP + i));
  return [...head, `       ... ${lines.length - CAP * 2} lines omitted ...`, ...tail].join("\n");
}

export function registerEditRange(server: McpServer): void {
  server.tool(
    "edit_range",
    "Replace a span of lines by number (1-based, inclusive) with new text — for JSON/markdown/config or any fragment awkward to quote exactly. Line numbers must come from read_file on the SAME file version; if another agent edited the file since your read, the numbers may point at the wrong content (the replaced content is echoed back so you can verify). To insert without deleting, set end_line = start_line - 1. Prefer edit_file for exact-text substitution, edit_symbol for a named code symbol.",
    {
      file_path: z.string().describe("Path to the file to edit — absolute, or relative to the agentruntime root"),
      start_line: z.number().int().describe("First line to replace (1-based, inclusive — matches read_file's numbered output)"),
      end_line: z.number().int().describe("Last line to replace (1-based, inclusive). Set to start_line - 1 to insert before start_line without deleting anything."),
      new_text: z.string().describe("Replacement text for the span — may be multi-line. Use empty string \"\" to delete the span."),
      why: z.string().optional().describe("One clause: why this edit. Published on the edit plane for other agents on this file."),
      hold: z.boolean().optional().describe("Stage on the plane WITHOUT touching disk; land later with land_edits."),
    },
    async ({ file_path: rawPath, start_line, end_line, new_text, why, hold }) => {
      const file_path = normalizePath(rawPath);
      try {
        const content = readFileSync(file_path, "utf-8");
        const eol = content.includes("\r\n") ? "\r\n" : "\n";
        const lines = content.split(/\r?\n/);
        const totalLines = lines.length;

        // Bounds validation — clear errors, never silent clamping.
        if (start_line < 1) {
          return { content: [{ type: "text" as const, text: `Error: start_line must be >= 1 (got ${start_line})` }], isError: true };
        }
        if (end_line < start_line - 1) {
          return { content: [{ type: "text" as const, text: `Error: end_line (${end_line}) must be >= start_line - 1 (${start_line - 1})` }], isError: true };
        }
        // Checked before end_line's own bound so an out-of-range start_line is
        // attributed to start_line, not misreported as an end_line problem —
        // end_line >= start_line - 1 (just checked) means once start_line is
        // in range, end_line <= totalLines is the only way it can still be invalid.
        if (start_line > totalLines + 1) {
          return { content: [{ type: "text" as const, text: `Error: start_line (${start_line}) exceeds file length (${totalLines} lines)` }], isError: true };
        }
        if (end_line > totalLines) {
          return { content: [{ type: "text" as const, text: `Error: end_line (${end_line}) exceeds file length (${totalLines} lines)` }], isError: true };
        }

        // Splice — same mechanic as edit-symbol.ts's structural replace.
        const before = lines.slice(0, start_line - 1);
        const oldSpanLines = lines.slice(start_line - 1, end_line);
        const after = lines.slice(end_line);
        const newLines = new_text === "" ? [] : new_text.replace(/\r\n/g, "\n").split("\n");
        const updated = [...before, ...newLines, ...after].join(eol);

        // Line numbers are the most staleness-exposed addressing we have — if
        // the file moved since the caller's read_file, these numbers point at
        // someone else's code. The plane refuses instead of overwriting.
        const plane = planeWrite(file_path, updated, { tool: "edit_range", base: content, why, hold });
        if (!plane.ok) {
          return { content: [{ type: "text" as const, text: plane.message }], isError: true };
        }
        if (plane.status === "pending") {
          return { content: [{ type: "text" as const, text: plane.message }] };
        }

        let message = `Replaced lines ${start_line}-${end_line} in ${file_path} (${oldSpanLines.length} → ${newLines.length} lines).`;

        // Echo replaced content — staleness safety net: if another agent edited the
        // file since this caller's read, the echoed text won't match what they expect.
        if (oldSpanLines.length > 0) {
          message += "\n\n── Replaced content ──\n" + previewSpan(oldSpanLines, start_line);
        }

        // Ripple detection — best-effort, fire-and-forget (mirrors edit.ts / edit-symbol.ts).
        try {
          const ripple = await detectRipple(file_path);
          if (ripple && ripple.changes.length > 0) {
            message += "\n\n── Structural changes detected ──";
            for (const change of ripple.changes) {
              message += `\n  ${change.kind}: ${change.detail}`;
            }
            if (ripple.affected.length > 0) {
              message += "\n\n── Affected files ──";
              for (const af of ripple.affected.slice(0, 15)) {
                message += `\n  ${af.file}:${af.line} → ${af.usage}`;
              }
              if (ripple.affected.length > 15) {
                message += `\n  ... and ${ripple.affected.length - 15} more`;
              }
            } else if (ripple.changes.some((c) => c.kind !== "addition")) {
              message += "\n\n── No importers ──\n  the changed export(s) have zero in-tree dependents (analyzed against HEAD).";
            }
          } else if (rippleBaselineMissing(file_path)) {
            message += "\n\n── Ripple not analyzed ──\n  no committed baseline (file not in HEAD); commit it to enable ripple on future edits.";
          }
        } catch {
          // ripple detection is best-effort — the edit already succeeded
        }

        message += formatHiddenCharWarning(scanHiddenCodepoints(new_text), "new_text");

        return { content: [{ type: "text" as const, text: message }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error: ${err.message}` }], isError: true };
      }
    },
  );
}
