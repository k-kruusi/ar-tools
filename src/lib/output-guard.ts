import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { funnelReversible } from "@agentruntime/token-funnel";
import { ccrStash } from "./ccr-store.js";
import { abSample, abEnabled } from "./ab-report.js";

/**
 * A single oversized-output contract, applied centrally.
 *
 * ## Why central and not per tool
 *
 * Measured 2026-08-29: of 17 ar-tools, only `bash` and `grep` funnel their output. The rest
 * either truncate ad hoc (`web_fetch`'s max_length), have a bespoke strategy (`read_file`'s
 * outline + offset/limit, `read_symbol`'s extraction), or have none at all. Three good designs
 * and fourteen gaps is not a contract, and the gaps are exactly where a result lands in a
 * caller's context whole.
 *
 * `createMcpServer` registers every tool through one loop, so wrapping `server.tool` there
 * covers all of them and — more importantly — cannot MISS one added later. A per-tool guard is
 * a rule everyone must remember; this is a property of the server.
 *
 * ## What it does, and the one thing it must never do
 *
 * Over the threshold, output is compressed by `token-funnel` with `labelMarkers`, and the
 * dropped bytes are stashed under a `<<ccr:HASH>>` marker recoverable with `ccr_retrieve`.
 * That is the pattern this package already got right in `bash`: **compress, but leave a handle**.
 * It must never silently truncate — a caller cannot tell a cut result from a complete one, and
 * acting on a half-result is worse than being told to go fetch the rest (the Honest Response
 * Principle in CLAUDE.md).
 *
 * ## OFF BY DEFAULT — this is an A/B
 *
 * Enabled by `AR_TOOLS_OUTPUT_GUARD=1`. With it off, every tool returns exactly what it
 * returned before, so the control arm is the current behaviour with no code path in common.
 * `AR_TOOLS_OUTPUT_GUARD_CHARS` overrides the threshold for tuning the comparison.
 *
 * Tools that already funnel (`bash`, `grep`) are unaffected in practice: their output arrives
 * here already under the threshold, so it passes through untouched rather than double-compressed.
 */

const DEFAULT_MAX_CHARS = 24_000;

export function outputGuardEnabled(): boolean {
  return process.env.AR_TOOLS_OUTPUT_GUARD === "1";
}

function maxChars(): number {
  const raw = Number(process.env.AR_TOOLS_OUTPUT_GUARD_CHARS);
  return Number.isFinite(raw) && raw > 1000 ? raw : DEFAULT_MAX_CHARS;
}

interface TextBlock { type: string; text?: string; [k: string]: unknown }
interface ToolResult { content?: TextBlock[]; [k: string]: unknown }

/** Compress one oversized text block, leaving a recovery marker. */
function guardText(text: string, toolName: string, limit: number): string {
  const funneled = funnelReversible(text, undefined, {
    maxChars: limit,
    isError: false,
    labelMarkers: true,
  });
  ccrStash(funneled.stashed);
  if (funneled.text.length >= text.length) return text;
  return `${funneled.text}\n\n[output-guard: ${toolName} returned ${text.length} chars, compressed to ${funneled.text.length}. The dropped spans are recoverable with ccr_retrieve on the markers above — nothing was silently discarded.]`;
}

/**
 * Wrap `server.tool` so every handler registered afterwards passes its result through the
 * guard. Call BEFORE registering tools.
 */
export function guardServerOutputs(server: McpServer): void {
  // Install when EITHER the guard is on OR the experiment is on. With only the guard's flag
  // gating installation, the CONTROL arm could never report — nothing would be measuring the
  // unguarded sizes — and the comparison would have one arm. So `AR_TOOLS_AB=1` alone
  // installs a MEASURE-ONLY wrapper that changes no output.
  const compressing = outputGuardEnabled();
  if (!compressing && !abEnabled()) return;
  const limit = maxChars();
  const original = server.tool.bind(server) as (...args: unknown[]) => unknown;

  (server as unknown as { tool: (...args: unknown[]) => unknown }).tool = (...args: unknown[]) => {
    const name = typeof args[0] === "string" ? args[0] : "tool";
    const handlerIndex = args.length - 1;
    const handler = args[handlerIndex];
    if (typeof handler !== "function") return original(...args);

    const wrapped = async (...handlerArgs: unknown[]) => {
      const result = (await (handler as (...a: unknown[]) => unknown)(...handlerArgs)) as ToolResult;
      // Never reshape a result we do not understand — an unexpected shape is the tool's
      // contract, not ours to rewrite.
      if (!result || !Array.isArray(result.content)) return result;
      let touched = false;
      let before = 0;
      let after = 0;
      const content = result.content.map((block) => {
        if (block?.type !== "text" || typeof block.text !== "string") return block;
        before += block.text.length;
        // In measure-only mode nothing is rewritten, so `after` equals `before` by
        // construction — that IS the control arm's value.
        if (!compressing || block.text.length <= limit) { after += block.text.length; return block; }
        touched = true;
        const text = guardText(block.text, name, limit);
        after += text.length;
        return { ...block, text };
      });
      // The metric here is CHARACTERS RETURNED, not milliseconds: the guard exists to protect
      // context, so timing it would measure the wrong thing well.
      abSample({
        experiment: "ar-tools-output-guard",
        arm: compressing ? "guarded" : "unguarded",
        value: after,
        tool: name,
        meta: { before, after, compressed: touched, overLimit: before > limit },
      });
      return touched ? { ...result, content } : result;
    };
    const next = [...args];
    next[handlerIndex] = wrapped;
    return original(...next);
  };
}
