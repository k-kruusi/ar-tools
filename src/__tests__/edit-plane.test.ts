import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// The plane resolves its store from agentruntimeRoot(), which reads
// AGENTRUNTIME_ROOT — pin it to a scratch dir BEFORE importing, so tests never
// touch the real .plane.
const ROOT = mkdtempSync(join(tmpdir(), "plane-test-"));
// agentruntimeRoot() only honours AGENTRUNTIME_ROOT when agentruntime.json is
// present there — without this marker it walks up from cwd and finds the REAL
// tree, and the tests write into the live .plane. (Same trap .EVOLVE.md records
// for cite.mjs in fresh worktrees.)
writeFileSync(join(ROOT, "agentruntime.json"), "{}", "utf-8");
process.env.AGENTRUNTIME_ROOT = ROOT;
process.env.AR_AGENT_ID = "agent-A";

const { planeWrite, recordRead, planeLand, listPendings, planeBanner, pendingContent, readJournal } = await import(
  "../lib/edit-plane.js"
);

const target = join(ROOT, "shared.ts");

function asAgent<T>(name: string, fn: () => T): T {
  const prev = process.env.AR_AGENT_ID;
  process.env.AR_AGENT_ID = name;
  try {
    return fn();
  } finally {
    process.env.AR_AGENT_ID = prev;
  }
}

describe("edit plane", () => {
  beforeEach(() => {
    rmSync(join(ROOT, ".plane"), { recursive: true, force: true });
    mkdirSync(ROOT, { recursive: true });
    writeFileSync(target, "export const x = 1;\n", "utf-8");
  });

  afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

  it("lands normally when nothing else touched the file (byte-identical to a plain write)", () => {
    const base = readFileSync(target, "utf-8");
    recordRead(target, base);
    const res = planeWrite(target, "export const x = 2;\n", { tool: "edit_file", base });
    expect(res.ok).toBe(true);
    expect(res.status).toBe("landed");
    expect(readFileSync(target, "utf-8")).toBe("export const x = 2;\n");
  });

  it("REFUSES a write whose base is stale, and does not touch the file", () => {
    // Agent A reads.
    const seen = readFileSync(target, "utf-8");
    asAgent("agent-A", () => recordRead(target, seen));

    // Agent B lands a change in between.
    asAgent("agent-B", () => {
      recordRead(target, seen);
      const r = planeWrite(target, "export const x = 99; // B\n", {
        tool: "edit_file",
        base: seen,
        why: "B needed 99",
      });
      expect(r.status).toBe("landed");
    });

    // Agent A now writes against what it read minutes ago.
    const res = asAgent("agent-A", () =>
      planeWrite(target, "export const x = 3; // A\n", { tool: "edit_range", base: seen }),
    );

    expect(res.ok).toBe(false);
    expect(res.status).toBe("blocked");
    // B's bytes survive — this is the clobber that used to happen silently.
    expect(readFileSync(target, "utf-8")).toBe("export const x = 99; // B\n");
    // A is told WHO and WHY, not just "conflict".
    expect(res.message).toContain("agent-B");
    expect(res.message).toContain("B needed 99");
    // A's work is not lost.
    expect(pendingContent(res.id)).toBe("export const x = 3; // A\n");
  });

  it("hold stages without touching disk, and land applies it", () => {
    const base = readFileSync(target, "utf-8");
    recordRead(target, base);
    const staged = planeWrite(target, "export const x = 7;\n", {
      tool: "edit_file",
      base,
      hold: true,
      why: "part of a 2-file change",
    });
    expect(staged.status).toBe("pending");
    expect(readFileSync(target, "utf-8")).toBe(base); // disk untouched

    const { landed, refused } = planeLand({ id: staged.id });
    expect(refused).toHaveLength(0);
    expect(landed).toHaveLength(1);
    expect(readFileSync(target, "utf-8")).toBe("export const x = 7;\n");
    expect(listPendings(target)).toHaveLength(0);
  });

  it("orphans a staged edit whose base vanished instead of clobbering", () => {
    const base = readFileSync(target, "utf-8");
    recordRead(target, base);
    const staged = planeWrite(target, "export const x = 7;\n", { tool: "edit_file", base, hold: true });

    // Someone else rewrites the file while it sits staged.
    writeFileSync(target, "export const x = 500; // someone else\n", "utf-8");

    const { landed, refused } = planeLand({ id: staged.id });
    expect(landed).toHaveLength(0);
    expect(refused).toHaveLength(1);
    expect(refused[0].reason).toContain("no longer on disk");
    expect(readFileSync(target, "utf-8")).toBe("export const x = 500; // someone else\n");
  });

  it("force lands over a changed file (the documented escape hatch)", () => {
    const base = readFileSync(target, "utf-8");
    recordRead(target, base);
    const staged = planeWrite(target, "export const x = 7;\n", { tool: "edit_file", base, hold: true });
    writeFileSync(target, "export const x = 500;\n", "utf-8");

    const { landed, refused } = planeLand({ id: staged.id, force: true });
    expect(refused).toHaveLength(0);
    expect(landed).toHaveLength(1);
    expect(readFileSync(target, "utf-8")).toBe("export const x = 7;\n");
  });

  it("banner shows another agent's pending edit to a reader of the same file", () => {
    const base = readFileSync(target, "utf-8");
    asAgent("agent-B", () => {
      recordRead(target, base);
      planeWrite(target, "export const x = 42;\n", {
        tool: "edit_file",
        base,
        hold: true,
        why: "renaming x to fix the export",
      });
    });

    const banner = asAgent("agent-A", () => planeBanner(target));
    expect(banner).toContain("PENDING");
    expect(banner).toContain("agent-B");
    expect(banner).toContain("renaming x to fix the export");
  });

  it("ignores files outside the shared tree — no journal, no receipt, no banner", () => {
    const outside = join(mkdtempSync(join(tmpdir(), "plane-outside-")), "scratch.txt");
    const res = planeWrite(outside, "scratch\n", { tool: "write_file", base: null });
    expect(res.ok).toBe(true);
    expect(res.id).toBe("ungoverned");
    expect(readFileSync(outside, "utf-8")).toBe("scratch\n");
    // The whole point: a temp-file edit must not appear in the colony's journal.
    expect(readJournal(200).some((e) => e.path === outside)).toBe(false);
    expect(planeBanner(outside)).toBe("");
  });

  it("a file with no receipt still writes (new files, first touch) — degrades to today's behaviour", () => {
    const fresh = join(ROOT, "brand-new.ts");
    const res = planeWrite(fresh, "export const y = 1;\n", { tool: "write_file", base: null });
    expect(res.ok).toBe(true);
    expect(readFileSync(fresh, "utf-8")).toBe("export const y = 1;\n");
  });
});
