import { describe, it, expect } from "vitest";
import { markdownOutline } from "../tools/read.js";

function mdFixture(bodyLines: number): string[] {
  const lines = [
    "<!-- ---",
    "scent:",
    '  - agent: someone',
    "--- -->",
    "---",
    "name: fixture",
    "description: a test skill",
    "---",
    "# Title",
    "intro prose",
    "## Section One",
  ];
  for (let i = 0; i < bodyLines; i++) lines.push(`body line ${i}`);
  lines.push("## Section Two", "```", "# not a heading — inside a fence", "```", "### Sub");
  return lines;
}

describe("markdownOutline", () => {
  const lines = mdFixture(400);
  const out = markdownOutline("skills/fixture.md", lines);

  it("carries the frontmatter verbatim (the routing metadata survives the outline)", () => {
    expect(out).toContain("name: fixture");
    expect(out).toContain("description: a test skill");
  });

  it("notes the scent block by range instead of dumping it", () => {
    expect(out).toMatch(/scent\/comment block: lines 1-4/);
  });

  it("lists headings with line ranges", () => {
    expect(out).toMatch(/\d+-\d+ │ # Title/);
    expect(out).toMatch(/\d+-\d+ │ ## Section One/);
    expect(out).toMatch(/\d+-\d+ │ ### Sub/);
  });

  it("ignores heading-shaped lines inside code fences", () => {
    expect(out).not.toContain("not a heading");
  });

  it("a heading's range ends where the next heading starts", () => {
    const m = /(\d+)-(\d+) │ ## Section One/.exec(out)!;
    const next = /(\d+)-\d+ │ ## Section Two/.exec(out)!;
    expect(Number(m[2])).toBe(Number(next[1]) - 1);
  });
});
