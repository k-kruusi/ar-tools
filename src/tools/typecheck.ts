import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { execSync } from "node:child_process";
import { existsSync, statSync as fstatSync } from "node:fs";
import { dirname, resolve, relative } from "node:path";
import { z } from "zod";
import { normalizePath, agentruntimeRoot } from "../utils.js";

export function registerTypecheck(server: McpServer): void {
  server.tool(
    "typecheck",
    "Run TypeScript type checking on a package. Finds the nearest tsconfig.json and runs tsc --noEmit --incremental. Returns only errors.",
    {
      path: z.string().optional().describe("Path to a file or directory — finds the nearest tsconfig.json. Omit to check the whole project."),
    },
    async ({ path: rawPath }) => {
      try {
        const startPath = rawPath ? normalizePath(rawPath) : agentruntimeRoot();
        const tsconfig = findTsconfig(startPath);

        if (!tsconfig) {
          return {
            content: [{
              type: "text" as const,
              text: `No tsconfig.json found from ${startPath}`,
            }],
            isError: true,
          };
        }

        const tsconfigDir = dirname(tsconfig);
        const relTsconfig = relative(agentruntimeRoot(), tsconfig).replace(/\\/g, "/");

        try {
          execSync(`npx tsc --noEmit --incremental -p "${tsconfig}"`, {
            cwd: tsconfigDir,
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
            timeout: 60_000,
          });

          return {
            content: [{
              type: "text" as const,
              text: `No type errors in ${relTsconfig}`,
            }],
          };
        } catch (err: any) {
          const output = (err.stdout || "") + (err.stderr || "");
          const lines = output
            .split("\n")
            .filter((l: string) => l.includes("error TS"))
            .map((l: string) => l.trim())
            .slice(0, 50);

          if (lines.length === 0) {
            return {
              content: [{
                type: "text" as const,
                text: `tsc failed but no TS errors found. Raw output:\n${output.slice(0, 3000)}`,
              }],
              isError: true,
            };
          }

          const errorCount = lines.length;
          return {
            content: [{
              type: "text" as const,
              text: `${errorCount} type error(s) in ${relTsconfig}:\n\n${lines.join("\n")}${errorCount >= 50 ? "\n... (truncated)" : ""}`,
            }],
          };
        }
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    },
  );
}

function findTsconfig(startPath: string): string | null {
  let dir = startPath;

  if (!existsSync(dir)) return null;
  const stat = fstatSync(dir);
  if (!stat.isDirectory()) dir = dirname(dir);

  for (let i = 0; i < 20; i++) {
    const candidate = resolve(dir, "tsconfig.json");
    if (existsSync(candidate)) return candidate;

    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return null;
}
