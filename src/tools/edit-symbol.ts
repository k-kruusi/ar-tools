import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { normalizePath } from "../utils.js";
import { planeWrite } from "../lib/edit-plane.js";
import { init, getSymbol, detectLanguage } from "@agentruntime/tree-sitter";
import { detectRipple, rippleBaselineMissing } from "../lib/structural-diff.js";
import { scanHiddenCodepoints, formatHiddenCharWarning } from "../lib/hidden-chars.js";

/**
 * edit_symbol — the write-side complement to read_symbol.
 *
 * Locates a named symbol STRUCTURALLY (tree-sitter), then replaces its whole
 * line span with new_body. Because it matches by AST node, not by exact text,
 * it is immune to the whitespace / line-ending drift that breaks edit_file's
 * find-and-replace. Preferred for code edits; edit_file remains for arbitrary
 * text (config, prose, partial-line surgery).
 */
export function registerEditSymbol(server: McpServer): void {
  server.tool(
    "edit_symbol",
    "Replace a named symbol's entire body (function, class, method, type, variable) in a code file using tree-sitter — the write-side complement to read_symbol. Locates the symbol structurally (no exact-text match, so whitespace/line-ending drift can't break it) and swaps its full span for new_body. PREFER this over edit_file for replacing a whole code symbol; reports structural ripple to importers. Use edit_file for arbitrary text, config, prose, or partial-line edits.",
    {
      file_path: z.string().describe("Path to the code file — absolute, or relative to the agentruntime root"),
      symbol_name: z.string().describe("Symbol to replace — exact name or 'Class.method'. Use file_outline if unsure."),
      new_body: z.string().describe("Full replacement text for the symbol's span (the entire declaration — e.g. the whole function, including its signature line)."),
      fuzzy: z.boolean().optional().describe("Case-insensitive/partial name match when the exact name is unknown (default: false)"),
      why: z.string().optional().describe("One clause: why this edit. Published on the edit plane for other agents on this file."),
      hold: z.boolean().optional().describe("Stage on the plane WITHOUT touching disk; land later with land_edits."),
    },
    async ({ file_path: rawPath, symbol_name, new_body, fuzzy = false, why, hold }) => {
      const file_path = normalizePath(rawPath);
      try {
        if (!detectLanguage(file_path)) {
          return {
            content: [{ type: "text" as const, text: `Unsupported file type for edit_symbol. Supported: .ts, .tsx, .js, .jsx, .py. Use edit_file for other files.` }],
            isError: true,
          };
        }

        await init();
        const chunk = await getSymbol(file_path, symbol_name, { fuzzy });
        if (!chunk) {
          const hint = fuzzy ? "" : " Try fuzzy=true, or";
          return {
            content: [{ type: "text" as const, text: `Symbol "${symbol_name}" not found in ${file_path}.${hint} use file_outline to list available symbols.` }],
            isError: true,
          };
        }

        const content = readFileSync(file_path, "utf-8");
        const eol = content.includes("\r\n") ? "\r\n" : "\n";
        const lines = content.split(/\r?\n/);
        const newLines = new_body.replace(/\r\n/g, "\n").split("\n");

        // chunk.startLine/endLine are 1-based and inclusive.
        const before = lines.slice(0, chunk.startLine - 1);
        const after = lines.slice(chunk.endLine);
        const updated = [...before, ...newLines, ...after].join(eol);

        const plane = planeWrite(file_path, updated, { tool: "edit_symbol", base: content, why, hold });
        if (!plane.ok) {
          return { content: [{ type: "text" as const, text: plane.message }], isError: true };
        }
        if (plane.status === "pending") {
          return { content: [{ type: "text" as const, text: plane.message }] };
        }

        const oldSpan = chunk.endLine - chunk.startLine + 1;
        let message = `Replaced ${chunk.kind} "${chunk.name}" at ${file_path}:${chunk.startLine}-${chunk.endLine} (${oldSpan} → ${newLines.length} lines).`;

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
              // Breaking export change, analyzed, zero importers — distinct from
              // "not analyzed". (Additions don't ripple, so don't claim it for them.)
              message += "\n\n── No importers ──\n  the changed export(s) have zero in-tree dependents (analyzed against HEAD).";
            }
          } else if (rippleBaselineMissing(file_path)) {
            message +=
              "\n\n── Ripple not analyzed ──\n  no committed baseline (file not in HEAD); commit it to enable ripple on future edits.";
          }
        } catch {
          // ripple detection is best-effort — the edit already succeeded
        }

        message += formatHiddenCharWarning(scanHiddenCodepoints(new_body), "new_body");

        return { content: [{ type: "text" as const, text: message }] };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    },
  );
}
