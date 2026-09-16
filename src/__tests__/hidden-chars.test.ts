import { describe, it, expect } from "vitest";
import { scanHiddenCodepoints, formatHiddenCharWarning } from "../lib/hidden-chars.js";

// Build hidden chars explicitly from codepoints rather than embedding literal
// invisibles in this source — the very anti-pattern this module exists to flag.
const cp = (n: number) => String.fromCodePoint(n);
const ZWSP = cp(0x200b);
const RLO = cp(0x202e); // right-to-left override (Trojan-Source class)
const PDF = cp(0x202c); // pop directional formatting
const BELL = cp(0x07);
const LS = cp(0x2028); // line separator
const PS = cp(0x2029); // paragraph separator
const TAG_A = cp(0xe0041); // Tags block (astral)

describe("scanHiddenCodepoints", () => {
  it("returns nothing for clean ASCII + normal whitespace", () => {
    expect(scanHiddenCodepoints("const x = 1;\n\tfoo();\r\n")).toEqual([]);
  });

  it("returns nothing for ordinary printable unicode", () => {
    expect(scanHiddenCodepoints("café — naïve — 日本語 — 😀")).toEqual([]);
  });

  it("detects a zero-width space", () => {
    const f = scanHiddenCodepoints(`a${ZWSP}b`);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ codepoint: "U+200B", category: "zero-width", count: 1 });
  });

  it("detects bidi override controls (the Trojan-Source class)", () => {
    const f = scanHiddenCodepoints(`x${RLO}y${PDF}`);
    expect(f.map((x) => x.category)).toEqual(["bidi-control", "bidi-control"]);
    expect(f.map((x) => x.codepoint)).toContain("U+202E");
  });

  it("counts repeats and aggregates by codepoint", () => {
    const f = scanHiddenCodepoints(`${ZWSP}${ZWSP}${ZWSP}`);
    expect(f).toHaveLength(1);
    expect(f[0].count).toBe(3);
  });

  it("detects lone C0 controls but not tab/newline/CR", () => {
    const f = scanHiddenCodepoints(`ok\t\n\r then${BELL}bell`);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ codepoint: "U+0007", category: "control-c0" });
  });

  it("detects astral Tags-block codepoints (instruction smuggling)", () => {
    const f = scanHiddenCodepoints(`hi${TAG_A}`);
    expect(f).toHaveLength(1);
    expect(f[0].category).toBe("tag");
    expect(f[0].codepoint).toBe("U+E0041");
  });

  it("detects line/paragraph separators", () => {
    const f = scanHiddenCodepoints(`a${LS}b${PS}c`);
    expect(f.map((x) => x.category)).toEqual(["line-separator", "line-separator"]);
  });
});

describe("formatHiddenCharWarning", () => {
  it("is empty for no findings", () => {
    expect(formatHiddenCharWarning([], "content")).toBe("");
  });

  it("renders a warning naming the codepoints and the scanned noun", () => {
    const w = formatHiddenCharWarning(scanHiddenCodepoints(`a${ZWSP}b`), "new_text");
    expect(w).toContain("Hidden/control codepoints");
    expect(w).toContain("new_text");
    expect(w).toContain("U+200B");
    expect(w).toContain("ZERO WIDTH SPACE");
  });
});
