import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rippleBaselineMissing } from "../lib/structural-diff.js";

/**
 * rippleBaselineMissing gates the "── Ripple not analyzed ──" skip-note that
 * edit_file/edit_symbol print. It must be true ONLY for a supported code file
 * with no committed HEAD baseline — the one ambiguous-silence case — and false
 * for tracked code (real ripple runs), non-code, and json/yaml.
 */
describe("rippleBaselineMissing", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "rbm-"));
    const run = (cmd: string) => execSync(cmd, { cwd: dir, stdio: "pipe" });
    run("git init -q");
    run("git config user.email t@t.t");
    run("git config user.name t");
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("TRUE for an untracked code file (no HEAD baseline)", () => {
    const f = join(dir, "untracked.ts");
    writeFileSync(f, "export const x = 1;\n");
    expect(rippleBaselineMissing(f)).toBe(true);
  });

  it("FALSE for a committed code file (baseline exists → real ripple runs)", () => {
    const f = join(dir, "tracked.ts");
    writeFileSync(f, "export const y = 1;\n");
    execSync("git add tracked.ts", { cwd: dir, stdio: "pipe" });
    execSync("git commit -qm add", { cwd: dir, stdio: "pipe" });
    expect(rippleBaselineMissing(f)).toBe(false);
  });

  it("FALSE for a non-code file even when untracked (correct silence)", () => {
    const f = join(dir, "notes.md");
    writeFileSync(f, "# notes\n");
    expect(rippleBaselineMissing(f)).toBe(false);
  });

  it("FALSE for json even when untracked (correct silence)", () => {
    const f = join(dir, "data.json");
    writeFileSync(f, "{}\n");
    expect(rippleBaselineMissing(f)).toBe(false);
  });
});
