import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerDataShape } from "../tools/data-shape.js";
import { inferShape, semanticHint, locateArray } from "../lib/data-lens.js";

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: { type: string; text: string }[];
  isError?: boolean;
}>;

function makeMockServer() {
  const handlers = new Map<string, ToolHandler>();
  const server = {
    tool: (name: string, _d: string, _s: unknown, h: ToolHandler) => handlers.set(name, h),
  };
  return { server: server as unknown as McpServer, call: (n: string, a: Record<string, unknown>) => handlers.get(n)!(a) };
}

describe("data-lens engine: inferShape (claims-not-facts contract)", () => {
  it("reports presence-% so optionality is visible", () => {
    const recs = [{ id: 1, opt: "x" }, { id: 2 }, { id: 3, opt: "y" }, { id: 4 }];
    const s = inferShape(recs, { origin: "t", total: 4, exhausted: true });
    expect(s.fields.find((f) => f.path === "id")!.presencePct).toBe(100);
    expect(s.fields.find((f) => f.path === "opt")!.presencePct).toBe(50);
  });

  it("reports a type union, not a winner", () => {
    const recs = [{ v: "a" }, { v: 1 }, { v: "b" }, { v: null }];
    const s = inferShape(recs, { origin: "t", total: 4, exhausted: true });
    const types = s.fields.find((f) => f.path === "v")!.types.map((t) => t.type).sort();
    expect(types).toEqual(["null", "number", "string"]);
  });

  it("descends into nested objects (from.agent surfaces)", () => {
    const recs = [{ from: { agent: "a" } }, { from: { agent: "b" } }];
    const s = inferShape(recs, { origin: "t", total: 2, exhausted: true });
    expect(s.fields.map((f) => f.path)).toContain("from.agent");
  });

  it("flags enum candidates by cardinality, not high-cardinality ids", () => {
    const recs = Array.from({ length: 10 }, (_, i) => ({ status: i % 2 ? "open" : "closed", id: `id${i}` }));
    const s = inferShape(recs, { origin: "t", total: 10, exhausted: true });
    expect(s.fields.find((f) => f.path === "status")!.enumValues!.sort()).toEqual(["closed", "open"]);
    expect(s.fields.find((f) => f.path === "id")!.enumValues).toBeUndefined();
  });

  it('gates "uniform" on full-stream exhaustion (no false confidence on a window)', () => {
    const recs = [{ a: 1 }, { a: 2 }];
    const exhausted = inferShape(recs, { origin: "t", total: 2, exhausted: true });
    expect(exhausted.recordKind).toBe("uniform");
    const windowed = inferShape(recs, { origin: "t", total: "unbounded", exhausted: false });
    expect(windowed.recordKind).toBe("partial");
    expect(windowed.recordKind).not.toBe("uniform");
    expect(windowed.notes.join(" ")).toMatch(/not drained|beyond the sample/i);
  });

  it("computes a deterministic size-delta over the report vs the sample bytes", () => {
    const recs = Array.from({ length: 20 }, (_, i) => ({ id: i, why: "x".repeat(200), status: "open" }));
    const s = inferShape(recs, { origin: "t", total: 20, exhausted: true });
    expect(s.sizeDelta.reportBytes).toBeGreaterThan(0);
    expect(s.sizeDelta.sampleBytes).toBeGreaterThan(s.sizeDelta.reportBytes);
    expect(s.sizeDelta.savedPct).toBeGreaterThan(0);
  });
});

describe("data-lens engine: semanticHint (hints, never coercion)", () => {
  it("annotates epoch-ms / uuid / sha256 / hex32 / iso-date", () => {
    expect(semanticHint(1781411703817)).toBe("epoch-ms");
    expect(semanticHint(1781411703)).toBe("epoch-s");
    expect(semanticHint("550e8400-e29b-41d4-a716-446655440000")).toBe("uuid");
    expect(semanticHint("a".repeat(64))).toBe("sha256");
    expect(semanticHint("474bd5af8bf4030874138cd0a6c6eac4")).toBe("hex32-id");
    expect(semanticHint("2026-06-16T13:51:00")).toBe("iso-date");
    expect(semanticHint("just text")).toBeUndefined();
  });

  it("never coerces: the sampled value bytes are preserved as-seen", () => {
    const recs = [{ createdAt: 1781411703817 }];
    const s = inferShape(recs, { origin: "t", total: 1, exhausted: true });
    const f = s.fields.find((f) => f.path === "createdAt")!;
    expect(f.hint).toBe("epoch-ms");
    expect(f.sample).toBe("1781411703817"); // raw number, NOT a formatted date
  });
});

describe("data-lens engine: locateArray (Honest-Response)", () => {
  it("finds the sole array field of an object", () => {
    const r = locateArray({ petitions: [{ a: 1 }] });
    expect(r).not.toBeInstanceOf(Error);
    expect((r as { locator: string }).locator).toBe("$.petitions[]");
  });
  it("errors actionably when an object has no array field", () => {
    const r = locateArray({ a: 1, b: "x" });
    expect(r).toBeInstanceOf(Error);
    expect((r as Error).message).toMatch(/no array field|read_file/i);
  });
  it("errors listing candidates when multiple array fields exist", () => {
    const r = locateArray({ xs: [1], ys: [2] });
    expect(r).toBeInstanceOf(Error);
    expect((r as Error).message).toMatch(/xs/);
    expect((r as Error).message).toMatch(/ys/);
  });
  it("accepts a top-level array directly", () => {
    const r = locateArray([{ a: 1 }]);
    expect((r as { locator: string }).locator).toBe("$[]");
  });
});

describe("data_shape tool (integration over real-ish files)", () => {
  let dir: string;
  let mock: ReturnType<typeof makeMockServer>;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "datalens-"));
    mock = makeMockServer();
    registerDataShape(mock.server);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("shapes a petitions-like JSON object with optional fields", async () => {
    const file = join(dir, "petitions.json");
    writeFileSync(file, JSON.stringify({
      petitions: [
        { id: "474bd5af8bf4030874138cd0a6c6eac4", status: "open", createdAt: 1781411703817, action: "do x" },
        { id: "46a951b1d4f3048f5e24b38fd0ad1473", status: "resolved", createdAt: 1781412491310, action: "do y", resolution: { by: "kevin" } },
      ],
    }));
    const res = await mock.call("data_shape", { source: file });
    expect(res.isError).toBeFalsy();
    const text = res.content[0].text;
    expect(text).toMatch(/\$\.petitions\[\]/);
    expect(text).toMatch(/resolution.*50%|50%.*resolution/);
    expect(text).toMatch(/epoch-ms/);
  });

  it("returns a clear error (not empty) when there is no record array", async () => {
    const file = join(dir, "config.json");
    writeFileSync(file, JSON.stringify({ port: 3000, host: "localhost" }));
    const res = await mock.call("data_shape", { source: file });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/no array field|read_file/i);
  });

  it("errors clearly on a missing file", async () => {
    const res = await mock.call("data_shape", { source: join(dir, "nope.json") });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/not found/i);
  });

  it("samples JSONL line-by-line", async () => {
    const file = join(dir, "events.jsonl");
    writeFileSync(file, [
      JSON.stringify({ ts: 1, event: "a" }),
      JSON.stringify({ ts: 2, event: "b" }),
    ].join("\n") + "\n");
    const res = await mock.call("data_shape", { source: file });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toMatch(/event/);
  });

  it("surfaces the code-computed size-delta in the output", async () => {
    const file = join(dir, "big.json");
    writeFileSync(file, JSON.stringify({ items: Array.from({ length: 20 }, (_, i) => ({ id: i, blob: "x".repeat(120) })) }));
    const res = await mock.call("data_shape", { source: file });
    expect(res.content[0].text).toMatch(/shape \d+B vs .*\d+B — \d+% smaller/);
  });

  it("tolerates a torn JSONL line (skips it, keeps the good records)", async () => {
    const file = join(dir, "torn.jsonl");
    writeFileSync(file, `${JSON.stringify({ a: 1 })}\n${JSON.stringify({ a: 2 })}\n{ this is half-writ`);
    const res = await mock.call("data_shape", { source: file });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toMatch(/malformed skipped/);
  });
});
