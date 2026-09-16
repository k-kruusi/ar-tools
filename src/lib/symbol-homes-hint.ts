//
// Reads .repo-memory/cache/symbol-homes.json (written by the resident's graph
// indexing cycle via saveSymbolHomesMemo) and returns ONE prior-art line when the
// requested symbol is defined in files OTHER than the one being read.
//
// Contract — mirrors scentHint exactly:
//   - Zero latency: disk read only, no cross-cartridge call.
//   - SILENT on any failure: missing/corrupt/wrong-version memo => '' (no error,
//     no throw). read_symbol must never break because the memo is absent.
//   - Token-bounded: at most one line prepended to the tool output.
//   - BYTE-IDENTICAL output when there is nothing to say (returns '').

import { readFileSync, statSync } from "node:fs";
import { join, relative, isAbsolute } from "node:path";
import { agentruntimeRoot } from "../utils.js";

const MEMO_REL = join(".repo-memory", "cache", "symbol-homes.json");
const MEMO_TTL_MS = 5 * 60_000;
const MAX_FILES_IN_HINT = 3;

interface SymbolHomesMemo {
  version: number;
  symbols: Record<string, string[]>;
}

let memoCache: { data: SymbolHomesMemo | null; loadedAt: number; mtimeMs: number } | null = null;

function loadMemo(): SymbolHomesMemo | null {
  const path = join(agentruntimeRoot(), MEMO_REL);
  try {
    const mtimeMs = statSync(path).mtimeMs;
    if (
      memoCache &&
      memoCache.mtimeMs === mtimeMs &&
      Date.now() - memoCache.loadedAt < MEMO_TTL_MS
    ) {
      return memoCache.data;
    }
    const raw = JSON.parse(readFileSync(path, "utf-8")) as {
      version?: unknown;
      symbols?: unknown;
    };
    const isValid = raw.version === 1 && typeof raw.symbols === "object" && raw.symbols !== null;
    const data: SymbolHomesMemo | null = isValid
      ? { version: 1 as const, symbols: raw.symbols as Record<string, string[]> }
      : null;
    memoCache = { data, loadedAt: Date.now(), mtimeMs };
    return data;
  } catch {
    return memoCache?.data ?? null;
  }
}

/**
 * Returns a one-line prior-art hint if `symbolName` is defined in files OTHER
 * than `resolvedFilePath`. Returns '' when:
 *   - the memo is missing or corrupt (silent)
 *   - the symbol has only one home
 *   - all other homes are the same file being read
 *
 * Callers prepend the result verbatim (same contract as scentHint).
 */
export function symbolHomesHint(symbolName: string, resolvedFilePath: string): string {
  try {
    const memo = loadMemo();
    if (!memo) return "";

    const homes = memo.symbols[symbolName];
    if (!Array.isArray(homes) || homes.length < 2) return "";

    const root = agentruntimeRoot();
    const rel = isAbsolute(resolvedFilePath)
      ? relative(root, resolvedFilePath).replace(/\\/g, "/")
      : resolvedFilePath.replace(/\\/g, "/");

    const otherHomes = homes.filter((h) => h !== rel);
    if (otherHomes.length === 0) return "";

    const shown = otherHomes.slice(0, MAX_FILES_IN_HINT);
    const overflow = otherHomes.length - shown.length;
    const fileList = shown.join(", ") + (overflow > 0 ? `, +${overflow} more` : "");

    return `[prior-art] "${symbolName}" also defined in ${fileList} — ask_repo before adding a third.`;
  } catch {
    return "";
  }
}
