import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { statSync, readFileSync } from "node:fs";
import { z } from "zod";
import { normalizePath } from "../utils.js";
import {
  init,
  getOutline,
  formatOutline,
  detectLanguage,
} from "@agentruntime/tree-sitter";

export function registerFileOutline(server: McpServer): void {
  server.tool(
    "file_outline",
    "Get the structural outline of a code file — functions, classes, methods, interfaces with line ranges. Use this to understand a file's shape before reading specific sections.",
    {
      file_path: z.string().describe("Path to the code file — absolute, or relative to the agentruntime root"),
    },
    async ({ file_path: rawPath }) => {
      const file_path = normalizePath(rawPath);
      try {
        const lang = detectLanguage(file_path);
        if (!lang) {
          return {
            content: [{
              type: "text" as const,
              text: `Unsupported file type for outline. Supported: .ts, .tsx, .js, .jsx, .py. Use read_file instead.`,
            }],
            isError: true,
          };
        }
        // file_outline extracts CODE structure (functions/classes/types). JSON/YAML
        // parse fine but have no such symbols, so the outline would be silently
        // empty — declared-but-empty success, the Honest-Response violation. Reject
        // explicitly with an actionable pointer instead of returning empty.
        if (lang === "json" || lang === "yaml") {
          return {
            content: [{
              type: "text" as const,
              text: `file_outline covers code structure (functions, classes, types) — not ${lang} data, which has no such symbols. Use read_file to read it.`,
            }],
            isError: true,
          };
        }

        const stat = statSync(file_path);
        if (stat.isDirectory()) {
          return {
            content: [{ type: "text" as const, text: `Error: "${file_path}" is a directory.` }],
            isError: true,
          };
        }

        await init();
        const symbols = await getOutline(file_path);
        const totalLines = readFileSync(file_path, "utf-8").split("\n").length;
        const formatted = formatOutline(file_path, symbols, totalLines);

        return {
          content: [{
            type: "text" as const,
            text: formatted,
          }],
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
