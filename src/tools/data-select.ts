import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { existsSync, statSync } from "node:fs";
import { extname } from "node:path";
import { z } from "zod";
import { search } from "jmespath";
import { tryTOON } from "@agentruntime/log-as-state";
import { normalizePath } from "../utils.js";
import { sampleJson, sampleJsonl, type SampleResult } from "../lib/data-lens.js";

const DEFAULT_SCAN = 5000;
const DEFAULT_LIMIT = 100;

function err(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}
function ok(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

/** A field path like "resume.bundlePath" → a jmespath value expression of QUOTED
 *  identifiers ("resume"."bundlePath"), so user field names are treated as literal
 *  keys. Handles spaces/special chars, and prevents jmespath-expression injection:
 *  "length(@)" becomes a literal key lookup → null, not a computed column passed off
 *  as a projected field. */
function pathToJmes(field: string): string {
  return field.split(".").map((seg) => JSON.stringify(seg)).join(".");
}

export function registerDataSelect(server: McpServer): void {
  server.tool(
    "data_select",
    "Project ONLY the fields you name from a JSON/JSONL record array — the data-side analog of read_symbol, and a token-saver over reading the whole file. Pass field paths (e.g. ['id','action','resume.bundlePath']) discovered via data_shape; optionally filter with a jmespath `where` and cap with `limit`. Output is TOON (dense; falls back to JSON). Drops the heavy fields you didn't ask for.",
    {
      source: z.string().describe("Path to a .json or .jsonl/.log file (absolute, or relative to the agentruntime root)"),
      fields: z.array(z.string()).describe("Field paths to keep, e.g. ['id','action','resume.bundlePath']. Dotted paths descend into objects."),
      pointer: z.string().optional().describe("Dotted path to the record array inside a JSON object, e.g. 'petitions'. Omit to auto-detect."),
      where: z.string().optional().describe("jmespath boolean filter on each record, e.g. \"status == 'open'\" or \"urgency == 'high'\"."),
      limit: z.number().optional().describe(`Max records to return (default ${DEFAULT_LIMIT}).`),
      scan: z.number().optional().describe(`Max records to read before filtering (default ${DEFAULT_SCAN}); bounds memory on large files.`),
      format: z.enum(["toon", "json"]).optional().describe("Output encoding (default toon)."),
    },
    async ({ source: rawPath, fields, pointer, where, limit = DEFAULT_LIMIT, scan = DEFAULT_SCAN, format = "toon" }) => {
      const path = normalizePath(rawPath);
      if (!existsSync(path)) return err(`File not found: ${path}`);
      try {
        if (statSync(path).isDirectory()) return err(`"${path}" is a directory, not a data file.`);
      } catch (e) {
        return err(`Cannot stat ${path}: ${(e as Error).message}`);
      }
      if (!fields || fields.length === 0) return err(`fields must list at least one field path. Run data_shape first to see field names.`);

      const ext = extname(path).toLowerCase();
      let loaded: SampleResult | Error;
      if (ext === ".jsonl") loaded = sampleJsonl(path, scan);
      else if (ext === ".json") loaded = sampleJson(path, scan, pointer);
      else {
        const jsonl = sampleJsonl(path, scan);
        loaded = jsonl instanceof Error ? sampleJson(path, scan, pointer) : jsonl;
      }
      if (loaded instanceof Error) return err(`data_select could not read ${path}: ${loaded.message}`);

      // Build a jmespath expression: filter (optional) then a multiselect-hash that
      // keeps only the requested paths. Full dotted paths are quoted keys so two
      // fields with the same leaf name never collide. jmespath is the grammar — we
      // wrap it, we don't reinvent projection.
      const projection = fields.map((f) => `${JSON.stringify(f)}: ${pathToJmes(f)}`).join(", ");
      const filter = where ? `[?${where}]` : `[*]`;
      const expr = `${filter}.{${projection}}`;

      let projected: unknown;
      try {
        projected = search(loaded.records, expr);
      } catch (e) {
        return err(`Invalid selection (jmespath: ${(e as Error).message}). Check field paths / where syntax — e.g. where="status == 'open'".`);
      }
      const rows = Array.isArray(projected) ? projected : [];
      const matched = rows.length;
      const limited = rows.slice(0, limit);

      // Honest-Response: don't return an ambiguous empty body.
      if (matched === 0) {
        const scope = where ? ` matching where=${JSON.stringify(where)}` : "";
        const hint = where
          ? " — check the where field name/value (a wrong field name silently matches nothing), or widen it"
          : " — check field names with data_shape";
        const trunc = !loaded.exhausted ? ` (only the first ${loaded.records.length} of ${loaded.total} records were scanned — raise scan=)` : "";
        return ok(`0 of ${loaded.records.length} scanned records${scope}${hint}.${trunc}`);
      }
      const allNull = limited.every((r) => r !== null && typeof r === "object" && Object.values(r as object).every((v) => v === null));
      if (allNull) {
        return ok(`Matched ${matched} record(s), but every requested field is null in all of them. Either the paths (${fields.join(", ")}) don't exist, or those fields are genuinely null — run data_shape to check field names and presence.`);
      }

      // Honest count: when the stream wasn't drained, `matched` only counts the
      // scanned window, so it's a LOWER BOUND — never present it as the total.
      const matchedLabel = loaded.exhausted ? `${matched} matched` : `≥${matched} matched (lower bound)`;
      const notes: string[] = [];
      if (!loaded.exhausted) notes.push(`scanned only the first ${loaded.records.length} of ${loaded.total} records — matches beyond that are NOT counted; the count is a lower bound (raise scan= to read more)`);
      if (matched > limit) notes.push(`showing ${limited.length} of ${matchedLabel} (raise limit= for more)`);

      let body: string;
      let fmtLabel: string;
      if (format === "json") {
        body = JSON.stringify(limited, null, 2);
        fmtLabel = "JSON";
      } else {
        const toon = tryTOON(limited);
        if (toon) {
          body = toon.toon;
          fmtLabel = `TOON, ${toon.savedPercent}% smaller than JSON`;
        } else {
          body = JSON.stringify(limited, null, 2);
          fmtLabel = "JSON (TOON gave <10% savings)";
        }
      }

      const header = `${limited.length} record(s) · ${matchedLabel} · fields: ${fields.join(", ")} · ${fmtLabel}`
        + (notes.length ? `\n# ${notes.join(" · ")}` : "");
      return ok(`${header}\n\n${body}`);
    },
  );
}
