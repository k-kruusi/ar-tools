/**
 * hidden-chars — detect invisible / control codepoints in text about to be written.
 *
 * Why this exists (Honest-Response Principle, write side): write_file / edit_file take
 * their content as a JSON string, so the JSON-RPC layer DECODES backslash- and unicode-
 * escapes before the tool ever sees them. An agent that types `​` (intending the
 * literal six characters) actually hands the tool a real U+200B zero-width space — a
 * hidden character silently embedded in the file. That is the same "ambiguous garbage"
 * the principle forbids on the read side: the write looks successful, but the bytes on
 * disk contain something invisible the author never saw. This bit a real session three
 * times — ironically while fixing a hidden-char vulnerability.
 *
 * We don't refuse the write (the char may be intentional — bidi tests, fixtures); we
 * SURFACE it, so a silent embed becomes a visible, actionable note.
 */

export interface HiddenCharFinding {
  /** Human label for the category, e.g. "zero-width", "bidi-control". */
  category: string;
  /** Codepoint as U+XXXX (uppercase hex, ≥4 digits). */
  codepoint: string;
  /** A name for the specific codepoint when well-known, else "". */
  name: string;
  /** How many times it occurs in the scanned text. */
  count: number;
}

interface CharSpec {
  category: string;
  name: string;
}

/**
 * Codepoint → {category, name} for the named offenders. Ranges (Tags block, lone
 * C0/C1) are handled procedurally in classify() so this stays a lookup of the
 * specific, well-known invisibles worth naming.
 */
const NAMED: Record<number, CharSpec> = {
  0x00ad: { category: "soft-hyphen", name: "SOFT HYPHEN" },
  0x061c: { category: "bidi-control", name: "ARABIC LETTER MARK" },
  0x200b: { category: "zero-width", name: "ZERO WIDTH SPACE" },
  0x200c: { category: "zero-width", name: "ZERO WIDTH NON-JOINER" },
  0x200d: { category: "zero-width", name: "ZERO WIDTH JOINER" },
  0x200e: { category: "bidi-control", name: "LEFT-TO-RIGHT MARK" },
  0x200f: { category: "bidi-control", name: "RIGHT-TO-LEFT MARK" },
  0x2028: { category: "line-separator", name: "LINE SEPARATOR" },
  0x2029: { category: "line-separator", name: "PARAGRAPH SEPARATOR" },
  0x202a: { category: "bidi-control", name: "LEFT-TO-RIGHT EMBEDDING" },
  0x202b: { category: "bidi-control", name: "RIGHT-TO-LEFT EMBEDDING" },
  0x202c: { category: "bidi-control", name: "POP DIRECTIONAL FORMATTING" },
  0x202d: { category: "bidi-control", name: "LEFT-TO-RIGHT OVERRIDE" },
  0x202e: { category: "bidi-control", name: "RIGHT-TO-LEFT OVERRIDE" },
  0x2060: { category: "zero-width", name: "WORD JOINER" },
  0x2066: { category: "bidi-control", name: "LEFT-TO-RIGHT ISOLATE" },
  0x2067: { category: "bidi-control", name: "RIGHT-TO-LEFT ISOLATE" },
  0x2068: { category: "bidi-control", name: "FIRST STRONG ISOLATE" },
  0x2069: { category: "bidi-control", name: "POP DIRECTIONAL ISOLATE" },
  0xfeff: { category: "zero-width", name: "ZERO WIDTH NO-BREAK SPACE (BOM)" },
};

/** Classify a single codepoint as a hidden/control offender, or null if it's fine. */
function classify(cp: number): CharSpec | null {
  if (NAMED[cp]) return NAMED[cp];
  // Lone C0 controls except the three legitimate whitespace ones (\t \n \r).
  if (cp <= 0x1f && cp !== 0x09 && cp !== 0x0a && cp !== 0x0d) {
    return { category: "control-c0", name: "" };
  }
  // C1 controls.
  if (cp >= 0x80 && cp <= 0x9f) return { category: "control-c1", name: "" };
  // Unicode Tags block — invisible, used to smuggle instructions into text.
  if (cp >= 0xe0000 && cp <= 0xe007f) return { category: "tag", name: "" };
  return null;
}

function hex(cp: number): string {
  return "U+" + cp.toString(16).toUpperCase().padStart(4, "0");
}

/**
 * Scan text for hidden / control codepoints. Iterates by codepoint (for..of handles
 * astral chars like the Tags block correctly), aggregates by codepoint, and returns
 * one finding per distinct offender with its occurrence count. Empty array = clean.
 */
export function scanHiddenCodepoints(text: string): HiddenCharFinding[] {
  const counts = new Map<number, number>();
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (classify(cp)) counts.set(cp, (counts.get(cp) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([cp, count]) => {
      const spec = classify(cp)!;
      return { category: spec.category, codepoint: hex(cp), name: spec.name, count };
    });
}

/**
 * Render findings as a warning block to append to a write/edit success message, or ""
 * when there are none. `noun` describes what was scanned (e.g. "content", "new_text").
 */
export function formatHiddenCharWarning(findings: HiddenCharFinding[], noun = "content"): string {
  if (findings.length === 0) return "";
  const lines = findings.map((f) => {
    const named = f.name ? ` (${f.name})` : "";
    const times = f.count > 1 ? ` ×${f.count}` : "";
    return `  ${f.codepoint}${named} — ${f.category}${times}`;
  });
  return (
    `\n\n⚠ Hidden/control codepoints in the written ${noun} — these are INVISIBLE on screen ` +
    `and were likely introduced by an escape sequence decoding (e.g. a typed "\\u200b" becomes a real ` +
    `zero-width space). If unintended, rewrite without them (build escapes via String.fromCharCode). ` +
    `If intended, ignore this note.\n` +
    lines.join("\n")
  );
}
