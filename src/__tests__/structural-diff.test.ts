import { describe, it, expect } from "vitest";
import type { ExportInfo } from "@agentruntime/tree-sitter";
import { diffExports, importResolvesTo } from "../lib/structural-diff.js";

function exp(
  name: string,
  kind: string,
  signature?: string,
): ExportInfo {
  return { name, kind, isDefault: false, line: 1, ...(signature && { signature }) };
}

describe("diffExports", () => {
  it("reports no changes for identical exports", () => {
    const e = [exp("foo", "function", "(a: number)"), exp("Bar", "class")];
    expect(diffExports(e, e)).toEqual([]);
  });

  it("detects a real signature change (same name + kind, different params)", () => {
    const before = [exp("foo", "function", "(a: number)")];
    const after = [exp("foo", "function", "(a: number, b: string)")];
    const changes = diffExports(before, after);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ kind: "signature", symbol: "foo" });
    // the OLD behavior (kind-change only) would have missed this entirely
  });

  it("does NOT flag a signature change when params are unchanged", () => {
    const before = [exp("foo", "function", "(a: number)")];
    const after = [exp("foo", "function", "(a: number)")];
    expect(diffExports(before, after)).toEqual([]);
  });

  it("detects a kind change (function -> class) as 'kind', not 'signature'", () => {
    const before = [exp("Thing", "function", "()")];
    const after = [exp("Thing", "class")];
    const changes = diffExports(before, after);
    expect(changes.map((c) => c.kind)).toContain("kind");
    expect(changes.map((c) => c.kind)).not.toContain("signature");
  });

  it("detects a plain deletion", () => {
    const changes = diffExports([exp("gone", "function", "()")], []);
    expect(changes).toEqual([
      expect.objectContaining({ kind: "deletion", symbol: "gone" }),
    ]);
  });

  it("detects a plain addition", () => {
    const changes = diffExports([], [exp("fresh", "function", "()")]);
    expect(changes).toEqual([
      expect.objectContaining({ kind: "addition", symbol: "fresh" }),
    ]);
  });

  it("collapses a del+add of identical kind+signature into a rename, keyed on the OLD name", () => {
    const before = [exp("oldName", "function", "(x: number): void")];
    const after = [exp("newName", "function", "(x: number): void")];
    const changes = diffExports(before, after);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ kind: "rename", symbol: "oldName" });
    expect(changes[0].detail).toContain("newName");
  });

  it("does NOT treat a del+add with different signatures as a rename", () => {
    const before = [exp("a", "function", "(x: number)")];
    const after = [exp("b", "function", "(x: number, y: number)")];
    const kinds = diffExports(before, after).map((c) => c.kind).sort();
    expect(kinds).toEqual(["addition", "deletion"]);
  });

  it("does NOT rename-match signatureless exports (types/variables)", () => {
    // No signature => ambiguous; must stay deletion + addition.
    const before = [exp("OldType", "type")];
    const after = [exp("NewType", "type")];
    const kinds = diffExports(before, after).map((c) => c.kind).sort();
    expect(kinds).toEqual(["addition", "deletion"]);
  });
});

describe("importResolvesTo", () => {
  const dir = "/repo/pkg/src";

  it("matches an extension-swapped specifier ('./lib/x.js' -> x.ts)", () => {
    expect(importResolvesTo(dir, "./lib/x.js", "/repo/pkg/src/lib/x.ts")).toBe(true);
  });

  it("matches an extensionless specifier ('./lib/x' -> x.ts)", () => {
    expect(importResolvesTo(dir, "./lib/x", "/repo/pkg/src/lib/x.ts")).toBe(true);
  });

  it("matches a directory specifier via index ('./lib' -> lib/index.ts)", () => {
    expect(importResolvesTo(dir, "./lib", "/repo/pkg/src/lib/index.ts")).toBe(true);
  });

  it("matches an exact path", () => {
    expect(importResolvesTo(dir, "./lib/x.ts", "/repo/pkg/src/lib/x.ts")).toBe(true);
  });

  it("does not match an unrelated module", () => {
    expect(importResolvesTo(dir, "./other", "/repo/pkg/src/lib/x.ts")).toBe(false);
  });

  it("does not match a same-named file in a different directory", () => {
    expect(importResolvesTo(dir, "./x", "/repo/pkg/src/lib/x.ts")).toBe(false);
  });
});
