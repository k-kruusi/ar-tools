import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { existsSync, statSync } from "node:fs";
import { extname } from "node:path";
import { z } from "zod";
import { normalizePath } from "../utils.js";
import { inferShape, formatShape, sampleJson, sampleJsonl, type SampleResult } from "../lib/data-lens.js";

function err(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}

export function registerDataShape(server: McpServer): void {
  server.tool(
    "data_shape",
    "Infer the SHAPE of a JSON or JSONL record array without reading the whole file — per field: type(s), how often present (optionality), a sample value, enum candidates, and semantic hints (epoch-ms, uuid, sha256, …). The data-side analog of file_outline: call this FIRST to learn field names, then data_select to pull only the ones you want (far fewer tokens than reading the file). The shape is a CLAIM stamped with its sample size: it reports how much smaller it is than the data, will NOT claim 'uniform' unless it read the whole array (else 'partial'), and never coerces values.",
    {
      source: z.string().describe("Path to a .json or .jsonl/.log file (absolute, or relative to the agentruntime root)"),
      pointer: z.string().optional().describe("Dotted path to the record array inside a JSON object, e.g. 'petitions'. Omit to auto-detect a sole array field."),
      sample: z.number().optional().describe("Max records to sample (default 1000). Bigger = more accurate shape and 'uniform' only claimable when the whole array fits the sample; shape size is unaffected (it's bounded by field count, not record count)."),
    },
    async ({ source: rawPath, pointer, sample = 1000 }) => {
      const path = normalizePath(rawPath);
      if (!existsSync(path)) return err(`File not found: ${path}`);
      try {
        if (statSync(path).isDirectory()) return err(`"${path}" is a directory, not a data file.`);
      } catch (e) {
        return err(`Cannot stat ${path}: ${(e as Error).message}`);
      }
      if (sample < 1) return err(`sample must be >= 1 (got ${sample}).`);

      const ext = extname(path).toLowerCase();
      let result: SampleResult | Error;
      if (ext === ".jsonl") {
        result = sampleJsonl(path, sample);
      } else if (ext === ".json") {
        result = sampleJson(path, sample, pointer);
      } else {
        // .log / unknown: action.logs are JSONL — try that first, fall back to JSON.
        const jsonl = sampleJsonl(path, sample);
        result = jsonl instanceof Error ? sampleJson(path, sample, pointer) : jsonl;
      }
      if (result instanceof Error) return err(`data_shape could not read ${path}: ${result.message}`);

      const shape = inferShape(result.records, {
        origin: result.locator,
        total: result.total,
        exhausted: result.exhausted,
      });
      const sd = shape.sizeDelta;
      const footer = sd.sampleBytes > 0
        ? `\n\nshape ${sd.reportBytes}B vs ${shape.sampled} sampled records ${sd.sampleBytes}B — ${sd.savedPct}% smaller`
        : "";
      return { content: [{ type: "text" as const, text: formatShape(shape) + footer }] };
    },
  );
}
