/**
 * Tests for symbolHomesHint (reader side of the prior-art injection).
 *
 * Covers:
 *   (a) symbol defined in 2+ files -> hint line names the OTHER files
 *   (b) single-home symbol -> returns '', output byte-identical to no-hint
 *   (c) missing symbol-homes.json -> returns '', no error
 *   (d) corrupt symbol-homes.json -> returns '', no error
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ── Test setup ────────────────────────────────────────────────────────────────
//
// symbolHomesHint reads from agentruntimeRoot() which resolves via AGENTRUNTIME_ROOT.
// We set this env var to a controlled temp dir before importing the module so that
// the module-level root cache lands on our temp dir.
//
// NOTE: set env BEFORE any import of the module under test, because agentruntimeRoot()
// memoizes on first call (module-level cache). Vitest runs each file in isolation,
// so our env setting is first in this module.

let tempRoot: string;
const MEMO_PATH_PARTS = [".repo-memory", "cache", "symbol-homes.json"];

function writeMemo(content: string): void {
  const dir = join(tempRoot, ...MEMO_PATH_PARTS.slice(0, -1));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(tempRoot, ...MEMO_PATH_PARTS), content, "utf-8");
}

function deleteMemo(): void {
  try { rmSync(join(tempRoot, ...MEMO_PATH_PARTS)); } catch { /* not present */ }
}

// ── Module import (after env setup) ──────────────────────────────────────────

let symbolHomesHint: (name: string, path: string) => string;

beforeAll(async () => {
  tempRoot = mkdtempSync(join(tmpdir(), "sym-hint-root-"));
  // Create the agentruntime.json marker so agentruntimeRoot() accepts the dir.
  writeFileSync(join(tempRoot, "agentruntime.json"), "{}", "utf-8");
  process.env.AGENTRUNTIME_ROOT = tempRoot;

  // Import AFTER env is set — the module's cachedRoot will be our temp dir.
  const mod = await import("../lib/symbol-homes-hint.js");
  symbolHomesHint = mod.symbolHomesHint;
});

afterAll(() => {
  delete process.env.AGENTRUNTIME_ROOT;
  try { rmSync(tempRoot, { recursive: true, force: true }); } catch { /* best effort */ }
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("symbolHomesHint", () => {
  it("(c) missing memo -> returns '' without throwing", () => {
    deleteMemo();
    expect(symbolHomesHint("anySymbol", "/absolute/path/file.ts")).toBe("");
  });

  it("(d) corrupt memo -> returns '' without throwing", () => {
    writeMemo("not valid json {{{");
    expect(symbolHomesHint("anySymbol", "/absolute/path/file.ts")).toBe("");
  });

  it("(d) wrong version memo -> returns '' without throwing", () => {
    writeMemo(JSON.stringify({ version: 99, symbols: { Foo: ["a.ts", "b.ts"] } }));
    expect(symbolHomesHint("Foo", "/absolute/path/file.ts")).toBe("");
  });

  it("(b) symbol not in memo -> returns '' (byte-identical, single-home case)", () => {
    writeMemo(JSON.stringify({ version: 1, symbols: {} }));
    expect(symbolHomesHint("NotPresent", `${tempRoot}/packages/a/src/a.ts`)).toBe("");
  });

  it("(b) symbol with one home -> NOT in memo -> returns ''", () => {
    // Single-home symbols are not written to the memo by the writer.
    writeMemo(JSON.stringify({ version: 1, symbols: {} }));
    expect(symbolHomesHint("SingleHome", `${tempRoot}/packages/a/src/a.ts`)).toBe("");
  });

  it("(a) multi-home symbol -> prepend line naming OTHER files, not the current one", () => {
    writeMemo(JSON.stringify({
      version: 1,
      symbols: {
        buildGraph: [
          "packages/graph-extractor/src/index.ts",
          "packages/tools/src/utils.ts",
        ],
      },
    }));
    // The file being read is packages/graph-extractor/src/index.ts (absolute path)
    const absPath = join(tempRoot, "packages", "graph-extractor", "src", "index.ts");
    const hint = symbolHomesHint("buildGraph", absPath);
    expect(hint).toContain("[prior-art]");
    expect(hint).toContain('"buildGraph"');
    // Other file named; the file being read is NOT listed
    expect(hint).toContain("packages/tools/src/utils.ts");
    expect(hint).not.toContain("packages/graph-extractor/src/index.ts");
    expect(hint).toContain("ask_repo before adding a third");
  });

  it("(a) all homes are the same as current file -> returns '' (no other homes)", () => {
    writeMemo(JSON.stringify({
      version: 1,
      symbols: {
        onlyHere: ["packages/a/src/a.ts"],
      },
    }));
    // onlyHere only in one file (but memo must have 2+ to be written — this
    // tests the reader's own guard for the impossible-but-handled case)
    const absPath = join(tempRoot, "packages", "a", "src", "a.ts");
    expect(symbolHomesHint("onlyHere", absPath)).toBe("");
  });

  it("(a) >3 other homes -> shows first 3 and '+N more'", () => {
    writeMemo(JSON.stringify({
      version: 1,
      symbols: {
        bigSymbol: [
          "packages/a/src/a.ts",
          "packages/b/src/b.ts",
          "packages/c/src/c.ts",
          "packages/d/src/d.ts",
          "packages/e/src/e.ts",
        ],
      },
    }));
    // Current file is packages/a — 4 others remain
    const absPath = join(tempRoot, "packages", "a", "src", "a.ts");
    const hint = symbolHomesHint("bigSymbol", absPath);
    expect(hint).toContain("+1 more");
    // Only 3 files shown explicitly
    const shownCount = (hint.match(/packages\//g) ?? []).length;
    expect(shownCount).toBe(3);
  });
});
