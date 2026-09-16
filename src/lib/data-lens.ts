// data-lens engine — the data-side analog of tree-sitter's symbol extraction.
// Pure, dependency-free. The MCP tools (data-shape.ts, data-select.ts) are thin
// wrappers over this. See dependencies/data-lens/README.md for the design + the
// honesty contract these functions implement.

import { readFileSync } from "node:fs";

export type JsonType = "string" | "number" | "boolean" | "null" | "object" | "array";

export interface TypeTally {
  type: JsonType;
  /** Percentage of *present* occurrences that had this type (0-100, rounded). */
  pct: number;
}

export interface FieldShape {
  /** Dotted path from the record root, e.g. "from.agent", "resume.bundlePath". */
  path: string;
  types: TypeTally[];
  /** Percentage of sampled records in which this path was present (0-100). */
  presencePct: number;
  /** First non-null value seen, stringified and truncated. Bytes as-seen — never coerced. */
  sample?: string;
  /** Distinct values, only when the field is low-cardinality (a candidate enum). */
  enumValues?: string[];
  /** Advisory semantic annotation (epoch-ms, uuid, sha256, …). A hint, not a coercion. */
  hint?: string;
}

export interface DataShape {
  origin: string;
  sampled: number;
  /** Total records if known (whole array parsed), else "unbounded" (stream not drained). */
  total: number | "unbounded";
  /** True only if every record was seen. `uniform` is gated on this. */
  exhausted: boolean;
  /** "uniform": all records objects + whole stream drained. "polymorphic": mixed
   *  shapes actually observed. "partial": all-object sample but stream not drained
   *  (uniform-looking, NOT confirmed). "empty": no records. */
  recordKind: "uniform" | "polymorphic" | "partial" | "empty";
  fields: FieldShape[];
  /** Deterministic, code-computed: is the shape report actually smaller than the sample? */
  sizeDelta: { reportBytes: number; sampleBytes: number; savedPct: number };
  /** Honest caveats surfaced to the reader (e.g. "sampled K of N — variants beyond K unknown"). */
  notes: string[];
}

const MAX_VALUE_LEN = 60;
const ENUM_MAX_CARDINALITY = 12;
const MAX_DEPTH = 4;

export function jsonType(v: unknown): JsonType {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v as JsonType; // "string" | "number" | "boolean" | "object"
}

/** Advisory semantic hint from a sampled value. Annotation only — the bytes are never changed. */
export function semanticHint(v: unknown): string | undefined {
  if (typeof v === "number" && Number.isInteger(v)) {
    if (v >= 1e12 && v < 4e12) return "epoch-ms";
    if (v >= 1e9 && v < 4e9) return "epoch-s";
    return undefined;
  }
  if (typeof v === "string") {
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) return "uuid";
    if (/^[0-9a-f]{64}$/i.test(v)) return "sha256";
    if (/^[0-9a-f]{32}$/i.test(v)) return "hex32-id";
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) return "iso-date";
    return undefined;
  }
  return undefined;
}

function truncate(s: string): string {
  return s.length > MAX_VALUE_LEN ? `${s.slice(0, MAX_VALUE_LEN)}…` : s;
}

function sampleString(v: unknown): string {
  if (typeof v === "string") {
    // Long free-text is boilerplate; report its length instead of inlining it.
    return v.length > MAX_VALUE_LEN ? `«len ${v.length}»` : JSON.stringify(v);
  }
  if (v === null || typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return `array[${v.length}]`;
  if (typeof v === "object") return `object{${Object.keys(v as object).join(",")}}`;
  return truncate(String(v));
}

interface FieldAccumulator {
  presentCount: number;
  typeCounts: Map<JsonType, number>;
  firstNonNull?: unknown;
  distinct: Set<string>;
  distinctOverflow: boolean;
}

/**
 * Infer a shape from already-sampled records. The caller owns sampling and tells us
 * whether the stream was exhausted — this function never reads I/O, so the
 * uniform-vs-partial decision is honest by construction.
 */
export function inferShape(
  records: unknown[],
  meta: { origin: string; total: number | "unbounded"; exhausted: boolean },
): DataShape {
  const notes: string[] = [];

  if (records.length === 0) {
    return {
      origin: meta.origin, sampled: 0, total: meta.total, exhausted: meta.exhausted,
      recordKind: "empty", fields: [],
      sizeDelta: { reportBytes: 0, sampleBytes: 0, savedPct: 0 },
      notes: ["No records sampled."],
    };
  }

  const allObjects = records.every((r) => jsonType(r) === "object");
  // Honest record-kind. "polymorphic" means we SAW mixed shapes (a fact, regardless
  // of exhaustion). "uniform" requires draining the whole stream. An all-object
  // sample from a stream we did NOT drain is "partial" — uniform-looking, unconfirmed.
  const recordKind: DataShape["recordKind"] = !allObjects
    ? "polymorphic"
    : meta.exhausted ? "uniform" : "partial";

  const accs = new Map<string, FieldAccumulator>();
  // Preserve first-seen path order for a stable, readable report.
  const order: string[] = [];

  function ensure(path: string): FieldAccumulator {
    let a = accs.get(path);
    if (!a) {
      a = { presentCount: 0, typeCounts: new Map(), distinct: new Set(), distinctOverflow: false };
      accs.set(path, a);
      order.push(path);
    }
    return a;
  }

  function visit(obj: Record<string, unknown>, prefix: string, depth: number): void {
    for (const [key, value] of Object.entries(obj)) {
      const path = prefix ? `${prefix}.${key}` : key;
      const a = ensure(path);
      a.presentCount++;
      const t = jsonType(value);
      a.typeCounts.set(t, (a.typeCounts.get(t) ?? 0) + 1);
      if (value !== null && a.firstNonNull === undefined) a.firstNonNull = value;

      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        if (!a.distinctOverflow) {
          a.distinct.add(typeof value === "string" ? value : String(value));
          if (a.distinct.size > ENUM_MAX_CARDINALITY) a.distinctOverflow = true;
        }
      }

      // Descend into nested objects (bounded) so from.agent / resume.bundlePath surface.
      if (t === "object" && depth < MAX_DEPTH) {
        visit(value as Record<string, unknown>, path, depth + 1);
      }
    }
  }

  if (allObjects) {
    for (const rec of records) visit(rec as Record<string, unknown>, "", 0);
  }

  const total = records.length;
  const fields: FieldShape[] = order.map((path) => {
    const a = accs.get(path)!;
    const types: TypeTally[] = [...a.typeCounts.entries()]
      .map(([type, n]) => ({ type, pct: Math.round((n / a.presentCount) * 100) }))
      .sort((x, y) => y.pct - x.pct);
    const fs: FieldShape = {
      path,
      types,
      presencePct: Math.round((a.presentCount / total) * 100),
    };
    if (a.firstNonNull !== undefined) fs.sample = sampleString(a.firstNonNull);
    const hint = a.firstNonNull !== undefined ? semanticHint(a.firstNonNull) : undefined;
    if (hint) fs.hint = hint;
    // Enum candidate: low cardinality, string/number/bool, and not every value distinct.
    if (!a.distinctOverflow && a.distinct.size > 0 && a.distinct.size < a.presentCount) {
      fs.enumValues = [...a.distinct];
    }
    return fs;
  });

  if (recordKind === "partial") {
    notes.push(`Sampled ${total} of ${meta.total} — all sampled records are objects, but the stream was not drained, so "uniform" is not claimed (variants beyond the sample unknown).`);
  } else if (!meta.exhausted) {
    notes.push(`Sampled ${total} of ${meta.total} — variants beyond the sample are unknown.`);
  }

  const base = {
    origin: meta.origin, sampled: total, total: meta.total, exhausted: meta.exhausted,
    recordKind, fields, notes,
  };
  const report = formatShape({ ...base, sizeDelta: { reportBytes: 0, sampleBytes: 0, savedPct: 0 } });
  const reportBytes = Buffer.byteLength(report, "utf-8");
  const sampleBytes = Buffer.byteLength(JSON.stringify(records), "utf-8");
  const savedPct = sampleBytes > 0 ? Math.round((1 - reportBytes / sampleBytes) * 100) : 0;
  if (savedPct <= 0) {
    notes.push(`Shape report (${reportBytes}B) is not smaller than the sampled data (${sampleBytes}B) — read_file may be simpler here.`);
  }

  return { ...base, sizeDelta: { reportBytes, sampleBytes, savedPct } };
}

/** Human-readable shape report. Pure formatting; the size-delta is measured over this string. */
export function formatShape(shape: DataShape): string {
  const out: string[] = [];
  const totalLabel = shape.total === "unbounded" ? "unbounded" : String(shape.total);
  out.push(`${shape.origin}   (${shape.sampled} of ${totalLabel} sampled — ${shape.recordKind})`);
  if (shape.recordKind === "empty") {
    out.push("  (no records)");
  }
  const pad = Math.min(28, Math.max(8, ...shape.fields.map((f) => f.path.length)));
  for (const f of shape.fields) {
    const typeStr = f.types.map((t) => (t.pct === 100 ? t.type : `${t.type}:${t.pct}%`)).join(" | ");
    const parts = [`  ${f.path.padEnd(pad)} ${typeStr.padEnd(10)} ${String(f.presencePct).padStart(3)}%`];
    if (f.presencePct < 100) parts.push("OPTIONAL");
    if (f.enumValues) parts.push(`∈ {${f.enumValues.join(", ")}}`);
    if (f.sample !== undefined) parts.push(`  ${f.sample}`);
    if (f.hint) parts.push(`hint:${f.hint}`);
    out.push(parts.join("  ").replace(/\s+$/, ""));
  }
  if (shape.notes.length) {
    out.push("");
    for (const n of shape.notes) out.push(`note: ${n}`);
  }
  return out.join("\n");
}

// ---- record sources ----------------------------------------------------------

export interface SampleResult {
  records: unknown[];
  total: number | "unbounded";
  exhausted: boolean;
  /** The resolved pointer/array location, for the report header. */
  locator: string;
}

function navigate(root: unknown, pointer: string): unknown {
  const clean = pointer.replace(/^\$\.?/, "");
  if (clean === "") return root;
  let cur: unknown = root;
  for (const key of clean.split(".")) {
    if (cur === null || typeof cur !== "object" || Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/** Find the record array in a parsed JSON value: the value itself if an array, or
 *  (when an object) its sole array-valued field. Returns the array + its locator,
 *  or an Error describing why it couldn't (Honest-Response: actionable, never empty). */
export function locateArray(root: unknown, pointer?: string): { array: unknown[]; locator: string } | Error {
  if (pointer) {
    const v = navigate(root, pointer);
    if (Array.isArray(v)) return { array: v, locator: `$.${pointer.replace(/^\$\.?/, "")}[]` };
    return new Error(`Pointer "${pointer}" does not resolve to an array (found ${jsonType(v)}).`);
  }
  if (Array.isArray(root)) return { array: root, locator: "$[]" };
  if (root !== null && typeof root === "object") {
    const arrayKeys = Object.entries(root as Record<string, unknown>).filter(([, v]) => Array.isArray(v));
    if (arrayKeys.length === 1) return { array: arrayKeys[0][1] as unknown[], locator: `$.${arrayKeys[0][0]}[]` };
    if (arrayKeys.length === 0) {
      return new Error(`Top level is a single object with no array field. Pass a pointer, or use read_file — there is no record array to shape.`);
    }
    return new Error(`Top level has ${arrayKeys.length} array fields (${arrayKeys.map((e) => e[0]).join(", ")}). Pass a pointer to pick one, e.g. pointer="${arrayKeys[0][0]}".`);
  }
  return new Error(`Top level is a ${jsonType(root)}, not a record array. Use read_file.`);
}

/** Sample a JSONL file (one JSON value per line). Tolerates malformed lines (a torn
 *  last line on a live log is normal) — skips them and notes the count. Returns an
 *  Error only if NOTHING parsed (probably not JSONL → caller can fall back to JSON). */
export function sampleJsonl(path: string, sample: number): SampleResult | Error {
  const text = readFileSync(path, "utf-8");
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  if (lines.length === 0) return new Error("File is empty — no lines to sample.");
  const slice = lines.slice(0, sample);
  const records: unknown[] = [];
  let malformed = 0;
  for (const line of slice) {
    try {
      records.push(JSON.parse(line));
    } catch {
      malformed++;
    }
  }
  if (records.length === 0) {
    return new Error(`No valid JSON found line-by-line (${malformed} malformed) — file may not be JSONL.`);
  }
  const note = malformed > 0 ? `, ${malformed} malformed skipped` : "";
  return {
    records,
    total: lines.length,
    exhausted: slice.length >= lines.length,
    locator: `${path} (JSONL lines${note})`,
  };
}

/** Sample a JSON file: parse, locate the record array, take up to `sample` records. */
export function sampleJson(path: string, sample: number, pointer?: string): SampleResult | Error {
  let root: unknown;
  try {
    root = JSON.parse(readFileSync(path, "utf-8"));
  } catch (e) {
    return new Error(`Not valid JSON: ${(e as Error).message}`);
  }
  const located = locateArray(root, pointer);
  if (located instanceof Error) return located;
  const { array, locator } = located;
  const records = array.slice(0, sample);
  return { records, total: array.length, exhausted: records.length >= array.length, locator };
}
