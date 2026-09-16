import { describe, it, expect, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { funnel, funnelReversible } from "@agentruntime/token-funnel";
import { registerCcr } from "../tools/ccr.js";
import {
  ccrStash,
  ccrRetrieve,
  ccrClearForTesting,
  ccrStoreSizeForTesting,
} from "../lib/ccr-store.js";

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: { type: string; text: string }[];
  isError?: boolean;
}>;

function makeMockServer() {
  const handlers = new Map<string, ToolHandler>();
  const server = {
    tool: (_name: string, _desc: string, _schema: unknown, handler: ToolHandler) => {
      handlers.set(_name, handler);
    },
  } as unknown as McpServer;
  return {
    server,
    call: (name: string, args: Record<string, unknown>) => {
      const h = handlers.get(name);
      if (!h) throw new Error(`No handler for tool: ${name}`);
      return h(args);
    },
  };
}

// Generate enough lines to reliably trigger dropping with a tight budget.
function makeContent(lineCount: number): string {
  return Array.from({ length: lineCount }, (_, i) => `context line ${i}: filler text to consume budget`).join("\n");
}

beforeEach(() => {
  ccrClearForTesting();
});

// ── (a) Round-trip ────────────────────────────────────────────────────────────

describe("CCR round-trip", () => {
  it("stashed chunk is retrievable via its marker", () => {
    const raw = makeContent(200);
    const { stashed } = funnelReversible(raw, "generic", { maxChars: 500 });
    expect(stashed.length).toBeGreaterThan(0);

    ccrStash(stashed);

    for (const chunk of stashed) {
      const retrieved = ccrRetrieve(chunk.marker);
      expect(retrieved).toBe(chunk.content);
    }
  });

  it("ccr_retrieve MCP tool returns the exact original bytes", async () => {
    const raw = makeContent(200);
    const { stashed } = funnelReversible(raw, "generic", { maxChars: 500 });
    expect(stashed.length).toBeGreaterThan(0);
    ccrStash(stashed);

    const mock = makeMockServer();
    registerCcr(mock.server);

    const first = stashed[0];
    const result = await mock.call("ccr_retrieve", { marker: first.marker });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toBe(first.content);
  });

  it("accepts a bare hash (without <<ccr: wrapper)", async () => {
    const raw = makeContent(200);
    const { stashed } = funnelReversible(raw, "generic", { maxChars: 500 });
    ccrStash(stashed);

    const mock = makeMockServer();
    registerCcr(mock.server);

    const first = stashed[0];
    const bareHash = first.marker.replace(/^<<ccr:/, "").replace(/>>$/, "");
    const result = await mock.call("ccr_retrieve", { marker: bareHash });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toBe(first.content);
  });
});

// ── (b) LRU eviction — honest error, no crash/empty ─────────────────────────

describe("CCR LRU eviction", () => {
  it("evicted hash returns the honest error message, not a crash or empty string", async () => {
    // minHeadLines:0 + minTailLines:0 ensure the engine actually drops content
    // (the generic profile's defaultMinTailLines:30 would otherwise cover small
    // inputs entirely, leaving nothing to stash). Each iteration uses a unique i
    // so each stash entry has a distinct SHA-256 hash.
    const chunks: import("@agentruntime/token-funnel").StashedChunk[] = [];
    for (let i = 0; i < 501; i++) {
      const body = Array.from({ length: 30 }, (_, j) => `evict-${i}-line-${j}`).join("\n");
      const { stashed } = funnelReversible(body, "generic", {
        maxChars: 20,
        minHeadLines: 0,
        minTailLines: 0,
      });
      for (const s of stashed) chunks.push(s);
    }

    // Every iteration should produce at least one stash entry.
    expect(chunks.length).toBeGreaterThanOrEqual(501);

    ccrStash(chunks);

    // The store is capped at 500 entries.
    const { entries } = ccrStoreSizeForTesting();
    expect(entries).toBeLessThanOrEqual(500);

    // We stashed 501+ distinct chunks; the first one must have been evicted.
    const evictedMarker = chunks[0].marker;
    const retrieved = ccrRetrieve(evictedMarker);
    expect(retrieved).toBeNull();

    // The MCP tool must return isError: true with an actionable message.
    const mock = makeMockServer();
    registerCcr(mock.server);
    const result = await mock.call("ccr_retrieve", { marker: evictedMarker });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("expired from the recovery cache");
    expect(result.content[0].text).not.toBe(""); // never a silent empty
  });
});

// ── (c) Non-regression: funnel() output unchanged ────────────────────────────

describe("CCR non-regression of funnel()", () => {
  it("funnel() still returns a plain string and is deterministic", () => {
    const raw = makeContent(300);
    const first = funnel(raw, "generic", { maxChars: 1_000 });
    const second = funnel(raw, "generic", { maxChars: 1_000 });
    expect(first).toBe(second);
    expect(typeof first).toBe("string");
  });

  it("ccrStash side-effects do not alter funnel() output", () => {
    const raw = makeContent(200);
    const before = funnel(raw, "generic", { maxChars: 500 });

    // Stash something into the store.
    const { stashed } = funnelReversible(raw, "generic", { maxChars: 500 });
    ccrStash(stashed);

    // funnel() must be unaffected.
    const after = funnel(raw, "generic", { maxChars: 500 });
    expect(after).toBe(before);
  });
});

// ── (d) Bounded memory ────────────────────────────────────────────────────────

describe("CCR bounded memory", () => {
  it("store size stays within MAX_ENTRIES after high-volume stashing", () => {
    for (let i = 0; i < 600; i++) {
      const body = Array.from({ length: 20 }, (_, j) => `bounded-${i}-${j}`).join("\n");
      const { stashed } = funnelReversible(body, "generic", {
        maxChars: 20,
        minHeadLines: 0,
        minTailLines: 0,
      });
      ccrStash(stashed);
    }
    const { entries } = ccrStoreSizeForTesting();
    expect(entries).toBeLessThanOrEqual(500);
  });

  it("totalBytes never exceeds MAX_BYTES (50 MiB) after large stashes", () => {
    for (let i = 0; i < 100; i++) {
      // Each dropped chunk is ~1 KB.
      const body = Array.from({ length: 10 }, (_, j) => `${i}:${"x".repeat(100)}`).join("\n");
      const { stashed } = funnelReversible(body, "generic", {
        maxChars: 20,
        minHeadLines: 0,
        minTailLines: 0,
      });
      ccrStash(stashed);
    }
    const { bytes } = ccrStoreSizeForTesting();
    expect(bytes).toBeLessThanOrEqual(50 * 1_048_576);
  });
});
