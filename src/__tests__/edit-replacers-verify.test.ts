// Verifier's adversarial pass over the replacer cascade — targets the hazards
// the implementer flagged (whitespace-substring clobber, exact precedence,
// fuzzy false-matches, ambiguity) rather than the happy path.
import { describe, it, expect } from "vitest";
import { replaceWithStrategy } from "../lib/replacers.js";

describe("replacer cascade — adversarial verification", () => {
  it("exact match wins over a whitespace-variant elsewhere (no fuzzy hijack)", () => {
    const content = "foo = 1\nfoo  =  1\n"; // line1 exact, line2 ws-variant
    const r = replaceWithStrategy(content, "foo = 1", "X");
    expect(r.strategy).toBe("exact");
    expect(r.content).toBe("X\nfoo  =  1\n"); // exact replaced; variant untouched
  });

  it("whitespace path replaces the real-spacing span, preserving prefix/suffix", () => {
    const content = "const value  =  computeStuff(a,  b);\n";
    const r = replaceWithStrategy(content, "value = computeStuff(a, b)", "RESULT");
    expect(r.strategy).toBe("whitespace-normalized");
    expect(r.content).toBe("const RESULT;\n");
  });

  it("whitespace regex stays literal-anchored — won't jump to a different value", () => {
    const content = "a  =  1; a = 2;\n";
    const r = replaceWithStrategy(content, "a = 1", "Z");
    expect(r.content).toBe("Z; a = 2;\n"); // matched 'a  =  1', left 'a = 2' alone
  });

  it("does NOT fuzzy-match an unrelated identifier → throws not found", () => {
    const content = "function foo() { return 1; }\n";
    expect(() => replaceWithStrategy(content, "function bar() { return 1; }", "X")).toThrow(/not found/i);
  });

  it("identical-span ambiguity is refused, not silently picked", () => {
    const content = "  target\nmid\n  target\n"; // two identical '  target' spans
    expect(() => replaceWithStrategy(content, "target", "X")).toThrow(/multiple|context/i);
  });

  it("KNOWN LIMIT: differing-whitespace ambiguity picks the FIRST (documented, flagged via strategy)", () => {
    // Two lines trim-equal to 'target' but with different real spans (spaces vs tab):
    // each real span is unique, so line-trimmed replaces the first. This is the
    // inherent fuzzy tradeoff (matches opencode); the non-exact strategy name is the
    // signal to the caller that it was not an exact match.
    const content = "  target\n\ttarget\n";
    const r = replaceWithStrategy(content, "target", "X");
    expect(r.strategy).toBe("line-trimmed");
    expect(r.content).toBe("X\n\ttarget\n");
  });

  it("oversize guard fires on an internal-whitespace-bloated multi-line span", () => {
    const content = `TOP\n  mid();${" ".repeat(700)}\nBOT\n`;
    expect(() => replaceWithStrategy(content, "TOP\nmid();\nBOT", "X")).toThrow(/larger|oversize/i);
  });
});
