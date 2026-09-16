import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { normalizePath } from "../utils.js";
import { planeWrite } from "../lib/edit-plane.js";
import { scanHiddenCodepoints, formatHiddenCharWarning } from "../lib/hidden-chars.js";

export function registerWrite(server: McpServer): void {
  server.tool(
    "write_file",
    "Write content to a file. Creates parent directories if they don't exist. Overwrites existing files.",
    {
      file_path: z.string().describe("Path to the file to write — absolute, or relative to the agentruntime root"),
      content: z.string().describe("The content to write to the file"),
      create_dirs: z.boolean().optional().describe("Create parent directories if missing (default: true)"),
      why: z.string().optional().describe("One clause: why this write. Published on the edit plane for other agents on this file."),
      hold: z.boolean().optional().describe("Stage on the plane WITHOUT touching disk; land later with land_edits."),
    },
    async ({ file_path: rawPath, content, create_dirs, why, hold }) => {
      const file_path = normalizePath(rawPath);
      try {
        if (create_dirs !== false) {
          mkdirSync(dirname(file_path), { recursive: true });
        }

        // write_file is whole-file replacement — the most destructive tool here,
        // and the one with no content anchor at all. The plane's receipt check is
        // the only thing standing between a stale caller and another agent's file.
        const prior = existsSync(file_path) ? readFileSync(file_path, "utf-8") : null;
        const plane = planeWrite(file_path, content, { tool: "write_file", base: prior, why, hold });
        if (!plane.ok) {
          return { content: [{ type: "text" as const, text: plane.message }], isError: true };
        }
        if (plane.status === "pending") {
          return { content: [{ type: "text" as const, text: plane.message }] };
        }
        const bytes = Buffer.byteLength(content, "utf-8");

        const warning = formatHiddenCharWarning(scanHiddenCodepoints(content), "content");

        return {
          content: [{ type: "text" as const, text: `Wrote ${bytes} bytes to ${file_path}${warning}` }],
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
