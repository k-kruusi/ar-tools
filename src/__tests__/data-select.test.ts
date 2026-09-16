import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerDataSelect } from "../tools/data-select.js";

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: { type: string; text: string }[];
  isError?: boolean;
}>;

function makeMockServer() {
  const handlers = new Map<string, ToolHandler>();
  const server = { tool: (n: string, _d: string, _s: unknown, h: ToolHandler) => handlers.set(n, h) };
  return { server: server as unknown as McpServer, call: (n: string, a: Record<string, unknown>) => handlers.get(n)!(a) };
}

const PETITIONS = {
  petitions: [
    { id: "a1", status: "open", urgency: "normal", action: "deploy", why: "x".repeat(300), resume: { bundlePath: "b/a1.md" } },
    { id: "b2", status: "resolved", urgency: "high", action: "queue gpu", why: "y".repeat(300), resolution: { by: "kevin" } },
    { id: "c3", status: "open", urgency: "high", action: "push", why: "z".repeat(300), resume: { bundlePath: "b/c3.md" } },
  ],
};

describe("data_select tool", () => {
  let dir: string;
  let mock: ReturnType<typeof makeMockServer>;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dsel-"));
    file = join(dir, "petitions.json");
    writeFileSync(file, JSON.stringify(PETITIONS));
    mock = makeMockServer();
    registerDataSelect(mock.server);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("projects only the named fields and drops the heavy ones", async () => {
    const res = await mock.call("data_select", { source: file, fields: ["id", "action"] });
    expect(res.isError).toBeFalsy();
    const text = res.content[0].text;
    expect(text).toMatch(/a1/);
    expect(text).toMatch(/deploy/);
    expect(text).not.toMatch(/xxxx/); // the heavy `why` field is gone
  });

  it("descends into nested fields (resume.bundlePath)", async () => {
    const res = await mock.call("data_select", { source: file, fields: ["id", "resume.bundlePath"] });
    expect(res.content[0].text).toMatch(/b\/a1\.md/);
  });

  it("applies a jmespath where filter", async () => {
    const res = await mock.call("data_select", { source: file, fields: ["id"], where: "status == 'open'" });
    const text = res.content[0].text;
    expect(text).toMatch(/a1/);
    expect(text).toMatch(/c3/);
    expect(text).not.toMatch(/b2/); // resolved one filtered out
  });

  it("honors limit", async () => {
    const res = await mock.call("data_select", { source: file, fields: ["id"], limit: 1 });
    expect(res.content[0].text).toMatch(/showing 1 of/);
  });

  it("returns a clear message (not empty) on zero matches", async () => {
    const res = await mock.call("data_select", { source: file, fields: ["id"], where: "status == 'nope'" });
    expect(res.content[0].text).toMatch(/0 of 3/);
  });

  it("flags an all-null projection (wrong field names)", async () => {
    const res = await mock.call("data_select", { source: file, fields: ["nonexistent"] });
    expect(res.content[0].text).toMatch(/null|don't exist|data_shape/i);
  });

  it("errors on missing file and empty fields", async () => {
    expect((await mock.call("data_select", { source: join(dir, "no.json"), fields: ["id"] })).isError).toBe(true);
    expect((await mock.call("data_select", { source: file, fields: [] })).isError).toBe(true);
  });

  it("emits real TOON tabular output for a uniform projection", async () => {
    const res = await mock.call("data_select", { source: file, fields: ["id", "status", "urgency"] });
    expect(res.content[0].text).toMatch(/TOON/);
    expect(res.content[0].text).toMatch(/\[\d+\]\{/); // TOON tabular header, e.g. [3]{id,status,urgency}
  });
});

describe("data_select — honesty + robustness (review fixes)", () => {
  let dir: string;
  let mock: ReturnType<typeof makeMockServer>;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dsel2-"));
    mock = makeMockServer();
    registerDataSelect(mock.server);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const write = (name: string, recs: unknown[]) => {
    const f = join(dir, name);
    writeFileSync(f, JSON.stringify(recs));
    return f;
  };

  it("labels the match count as a LOWER BOUND when the file isn't fully scanned", async () => {
    const f = write("big.json", Array.from({ length: 10 }, (_, i) => ({ id: i, status: "open" })));
    const res = await mock.call("data_select", { source: f, fields: ["id"], where: "status == 'open'", scan: 4 });
    const text = res.content[0].text;
    expect(text).toMatch(/lower bound/i);
    expect(text).toMatch(/first 4 of 10/);
    expect(text).not.toMatch(/\b10 matched\b/); // must NOT present 10 as the matched total
  });

  it("distinguishes a genuinely-null field from a missing one", async () => {
    const f = write("nulls.json", [{ id: 1, deletedAt: null }, { id: 2, deletedAt: null }]);
    const res = await mock.call("data_select", { source: f, fields: ["deletedAt"] });
    expect(res.content[0].text).toMatch(/genuinely null/i);
    expect(res.content[0].text).toMatch(/presence|data_shape/i);
  });

  it("handles field names with spaces via quoted paths (no jmespath parse error)", async () => {
    const f = write("spaces.json", [{ "weird key": "v1" }, { "weird key": "v2" }]);
    const res = await mock.call("data_select", { source: f, fields: ["weird key"] });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toMatch(/v1/);
  });

  it("does NOT let a field name inject a computed jmespath column", async () => {
    const f = write("inj.json", [{ id: 1 }, { id: 2 }, { id: 3 }]);
    const res = await mock.call("data_select", { source: f, fields: ["length(@)"] });
    // Quoted as a literal key → null (not a fabricated count of 3) → all-null message.
    expect(res.content[0].text).toMatch(/null/i);
    expect(res.content[0].text).not.toMatch(/\[\d+\]\{/); // no TOON table of computed values
  });
});
