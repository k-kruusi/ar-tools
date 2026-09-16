import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { glob } from "glob";
import { statSync } from "node:fs";
import { z } from "zod";
import { normalizePath, agentruntimeRoot } from "../utils.js";
import { scentHint } from "../lib/scent-hint.js";
import { skillHint } from "../lib/skill-hint.js";

export function registerGlob(server: McpServer): void {
  server.tool(
    "glob_files",
    "Find files matching a glob pattern. Returns paths sorted by modification time (newest first). Dot-directories (e.g. .claude/, .github/) are included; .git/ and node_modules/ are always excluded.",
    {
      pattern: z.string().describe("Glob pattern to match (e.g. '**/*.ts', 'src/**/*.json')"),
      path: z.string().optional().describe("Directory to search in — absolute, or relative to the agentruntime root. Defaults to the agentruntime root."),
      max_results: z.number().optional().describe("Max results to return (default: 200)"),
    },
    async ({ pattern, path: rawPath, max_results }) => {
      try {
        const cwd = rawPath ? normalizePath(rawPath) : agentruntimeRoot();
        const maxResults = max_results || 200;

        const matches = await glob(pattern, {
          cwd,
          absolute: true,
          nodir: true,
          dot: true,
          ignore: ["**/node_modules/**", "**/.git/**"],
        });

        // Sort by modification time (newest first)
        const withStats = matches.map((f) => {
          try {
            return { path: f, mtime: statSync(f).mtimeMs };
          } catch {
            return { path: f, mtime: 0 };
          }
        });
        withStats.sort((a, b) => b.mtime - a.mtime);

        const limited = withStats.slice(0, maxResults);
        const output = limited.map((f) => f.path).join("\n");

        const suffix = matches.length > maxResults
          ? `\n\n(${matches.length} total matches — showing first ${maxResults})`
          : "";

        // Ambient orientation (advisory, once per area per session) — see lib/scent-hint.ts.
        const paths = limited.map((f) => f.path);
        const hint = skillHint(paths) + scentHint(paths);

        return {
          content: [{ type: "text" as const, text: hint + (output || "(no matches)") + suffix }],
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
