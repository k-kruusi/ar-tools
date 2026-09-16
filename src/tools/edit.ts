import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { normalizePath } from "../utils.js";
import { planeWrite } from "../lib/edit-plane.js";
import { detectRipple, rippleBaselineMissing } from "../lib/structural-diff.js";
import { replaceWithStrategy } from "../lib/replacers.js";
import { scanHiddenCodepoints, formatHiddenCharWarning } from "../lib/hidden-chars.js";

export function registerEdit(server: McpServer): void {
  server.tool(
    "edit_file",
    "Find-and-replace in a file. The old_text must appear exactly once (for safety). Use read_file first to see the current contents. For code files, when an exported symbol is deleted, renamed, re-categorized, or its signature changes, returns the structural change plus the files that import it.",
    {
      file_path: z.string().describe("Path to the file to edit — absolute, or relative to the agentruntime root"),
      old_text: z.string().describe("The exact text to find and replace"),
      new_text: z.string().describe("The replacement text"),
      replace_all: z.boolean().optional().describe("Replace all occurrences instead of requiring uniqueness (default: false)"),
      why: z.string().optional().describe("One clause: why this edit. Published on the edit plane so another agent hitting the same file sees your reason, not just your bytes."),
      hold: z.boolean().optional().describe("Stage on the plane WITHOUT touching disk; land later with land_edits. Use for multi-file changes that must land together."),
    },
    async ({ file_path: rawPath, old_text, new_text, replace_all, why, hold }) => {
      const file_path = normalizePath(rawPath);
      try {
        const content = readFileSync(file_path, "utf-8");

        // Match against the FILE's line endings. Agents/editors usually send "\n",
        // but on Windows the working copy is often CRLF (git autocrlf). Without this,
        // an LF old_text never matches a CRLF file — a silent, common "old_text not
        // found" trap. Normalize old_text AND new_text to the file's EOL so matching
        // works and the file's existing ending style is preserved on write.
        const fileEol = content.includes("\r\n") ? "\r\n" : "\n";
        const toFileEol = (s: string) =>
          fileEol === "\r\n" ? s.replace(/\r?\n/g, "\r\n") : s.replace(/\r\n/g, "\n");
        const oldText = toFileEol(old_text);
        const newText = toFileEol(new_text);

        // Fuzzy replacer cascade: try exact match first, then progressively
        // looser strategies (per-line trimmed, block-anchor, whitespace-
        // normalized) that tolerate indentation / trailing-space drift. Each
        // strategy locates a span that exists VERBATIM in `content`, refuses an
        // oversize match, and enforces uniqueness — so a loose locator never
        // silently rewrites the wrong region. Thrown messages become isError.
        let updated: string;
        let strategy: string;
        let replacements: number;
        try {
          const result = replaceWithStrategy(content, oldText, newText, replace_all ?? false);
          updated = result.content;
          strategy = result.strategy;
          replacements = result.count;
        } catch (replaceErr: any) {
          return {
            content: [{ type: "text" as const, text: replaceErr.message }],
            isError: true,
          };
        }

        // Every write goes through the plane: refuse on a stale base, stage on
        // hold, otherwise land. See lib/edit-plane.ts.
        const plane = planeWrite(file_path, updated, { tool: "edit_file", base: content, why, hold });
        if (!plane.ok) {
          return { content: [{ type: "text" as const, text: plane.message }], isError: true };
        }
        if (plane.status === "pending") {
          return { content: [{ type: "text" as const, text: plane.message }] };
        }

        let message = `Replaced ${replacements} occurrence(s) in ${file_path}`;
        if (strategy !== "exact") {
          message += ` (matched via ${strategy} — old_text differed by whitespace/indentation)`;
        }

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
              // A breaking export change (rename/delete/signature/kind) that was
              // analyzed and found ZERO importers — distinct from "not analyzed".
              // (Pure additions don't ripple, so don't claim "zero importers" for them.)
              message += "\n\n── No importers ──\n  the changed export(s) have zero in-tree dependents (analyzed against HEAD).";
            }
          } else if (rippleBaselineMissing(file_path)) {
            message +=
              "\n\n── Ripple not analyzed ──\n  no committed baseline (file not in HEAD); commit it to enable ripple on future edits.";
          }
        } catch {
          // ripple detection failed silently — still return the edit success
        }

        message += formatHiddenCharWarning(scanHiddenCodepoints(new_text), "new_text");

        return {
          content: [{ type: "text" as const, text: message }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    },
  );
}
