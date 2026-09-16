import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { scrubToolOutput } from "../scrub-util.js";
import { normalizePath } from "../utils.js";
import { noteRangedRead } from "./read.js";
import { symbolHomesHint } from "../lib/symbol-homes-hint.js";
import { init, getSymbol, getSymbols, getSymbolWithImports, getOutline, formatOutline, detectLanguage } from "@agentruntime/tree-sitter";

async function outlineHint(file_path: string): Promise<string> {
  try {
    const symbols = await getOutline(file_path);
    if (symbols.length === 0) return "\n\n(outline: no symbols found)";
    const totalLines = readFileSync(file_path, "utf-8").split("\n").length;
    return "\n\nAvailable symbols:\n" + formatOutline(file_path, symbols, totalLines);
  } catch { return ""; }
}

function formatChunk(chunk: { path: string; startLine: number; endLine: number; kind: string; name: string; text: string }, resolvedFrom?: string): string {
  const header = `${chunk.path}:${chunk.startLine}-${chunk.endLine} [${chunk.kind} ${chunk.name}]`;
  const origin = resolvedFrom && resolvedFrom !== chunk.path ? ` (resolved from import)` : "";
  return `${header}${origin}\n\n${chunk.text}`;
}

export function registerReadSymbol(server: McpServer): void {
  server.tool(
    "read_symbol",
    "Read a single named symbol (function, class, method, type, variable) from a code file. Returns only that symbol's body — far fewer tokens than reading the whole file. Use file_outline first if you don't know the exact name. Set fuzzy=true for case-insensitive/partial matching. Set followImports=true to resolve symbols imported from other files.",
    {
      file_path: z.string().describe("Path to the code file — absolute, or relative to the agentruntime root"),
      symbol_name: z.string().describe("Symbol to extract — exact name or suffix (e.g. 'myFn', 'MyClass.method', 'method')"),
      fuzzy: z.boolean().optional().describe("Case-insensitive partial match when exact name is unknown (default: false)"),
      followImports: z.boolean().optional().describe("If not found in this file, follow imports to resolve from source (default: false)"),
    },
    async ({ file_path: rawPath, symbol_name, fuzzy = false, followImports = false }) => {
      const file_path = normalizePath(rawPath);
      noteRangedRead(file_path);
      if (!detectLanguage(file_path)) {
        return { content: [{ type: "text" as const, text: `Unsupported file type. Supported: .ts, .tsx, .js, .jsx, .py` }], isError: true };
      }
      await init();

      if (followImports) {
        const result = await getSymbolWithImports(file_path, symbol_name);
        if (!result) {
          const outline = await outlineHint(file_path);
          return { content: [{ type: "text" as const, text: `Symbol "${symbol_name}" not found in ${file_path} or its imports.${outline}` }], isError: true };
        }
        const { text, note } = scrubToolOutput(formatChunk(result.chunk, result.resolvedFrom));
        const priorArt = symbolHomesHint(symbol_name, result.chunk.path);
        const body = note ? `${text}\n\n${note}` : text;
        return { content: [{ type: "text" as const, text: priorArt ? `${priorArt}\n\n${body}` : body }] };
      }

      const chunk = await getSymbol(file_path, symbol_name, { fuzzy });
      if (!chunk) {
        const hint = fuzzy ? "" : " Try fuzzy=true for partial matching.";
        const outline = await outlineHint(file_path);
        return { content: [{ type: "text" as const, text: `Symbol "${symbol_name}" not found in ${file_path}.${hint}${outline}` }], isError: true };
      }
      const { text: scrubbed, note: scrubNote } = scrubToolOutput(formatChunk(chunk));
      const priorArt = symbolHomesHint(symbol_name, file_path);
      const body = scrubNote ? `${scrubbed}\n\n${scrubNote}` : scrubbed;
      return { content: [{ type: "text" as const, text: priorArt ? `${priorArt}\n\n${body}` : body }] };
    },
  );

  server.tool(
    "read_symbols",
    "Read multiple named symbols from a code file in a single call. More efficient than calling read_symbol repeatedly. Returns found symbols and lists any names that were missing.",
    {
      file_path: z.string().describe("Path to the code file — absolute, or relative to the agentruntime root"),
      symbol_names: z.array(z.string()).describe("Array of symbol names to extract"),
    },
    async ({ file_path: rawPath, symbol_names }) => {
      const file_path = normalizePath(rawPath);
      noteRangedRead(file_path);
      if (!detectLanguage(file_path)) {
        return { content: [{ type: "text" as const, text: `Unsupported file type. Supported: .ts, .tsx, .js, .jsx, .py` }], isError: true };
      }
      await init();
      const { found, missing } = await getSymbols(file_path, symbol_names);
      const parts: string[] = found.map((c) => formatChunk(c));
      if (missing.length > 0) {
        parts.push(`Missing (not found): ${missing.join(", ")}`);
      }
      const raw = parts.join("\n\n---\n\n");
      const { text: scrubbed, note: scrubNote } = scrubToolOutput(raw);
      return { content: [{ type: "text" as const, text: scrubNote ? `${scrubbed}\n\n${scrubNote}` : scrubbed }] };
    },
  );
}
