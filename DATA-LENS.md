# data-lens — `data_shape` + `data_select`

**The data-side analog of `file_outline` / `read_symbol`.** Show me the *shape* of a
JSON/JSONL record array, then let me pull *only the fields I name* — without dumping
the whole file into context.

> `read_symbol` saves you from reading a 2,000-line file to see one function.
> data-lens saves you from reading a 30-record JSON — or a 1 MB+ `action.log` — to
> get four fields per record.

**Status: BUILT** (2026-06-16). Two MCP tools in `packages/tools`, 24 tests, verified
live on `cartridges/ask/state/petitions.json` and a 1.18 MB `action.log`.
**Code-complete; goes live on the next `ar-tools` rebuild + restart** (with the
`file_outline` honesty fix below). Not a separate package — the §10 question resolved
to *two tools here*, wrapping proven libs.

## The two tools

| Code tool | Data tool | Operation |
|---|---|---|
| `file_outline` | **`data_shape`** | infer record shape: per field, type(s) + presence-% + sample value + enum/semantic hints |
| `read_symbol(name)` | **`data_select`** | project only the named field paths (+ jmespath `where`, `limit`); TOON output |

Call `data_shape` first (learn the field names), then `data_select` with the handful
you want — the `file_outline`→`read_symbol` rhythm, for data.

```
data_shape  source=cartridges/ask/state/petitions.json
data_select source=cartridges/ask/state/petitions.json fields=[id,action,urgency,status] where="status == 'open'"
```

## Wrap, don't reinvent (the lesson the v1 spec failed)

The primitives are solved; data-lens is a thin, honest, repo-native skin:

| Capability | Wrapped | data-lens adds |
|---|---|---|
| Project nested fields / filter | **`jmespath`** | the shape-first workflow + MCP ergonomics |
| Dense output | **`@agentruntime/log-as-state`** (TOON) | default-on for uniform arrays |
| Schema-from-JSON (future) | `quicktype`/`genson` | presence-% + the honesty contract |
| Stream a huge array (future) | `stream-json` | source adapters |

The genuine repo-native value is narrow and that's the point: TOON output, the
shape-first MCP ergonomics, Honest-Response errors, and a **code-computed** honesty
contract on the shape (below).

## The honesty contract (`inferShape`, `lib/data-lens.ts`)

JSON doesn't enforce types — it *likely* uses them — so the shape is a **claim about
the data**, the data is truth (`scent.md`, applied to bytes):

- **Sample across the stream; report presence-%** so optionality is visible.
- **Type unions, not a winner** (`string | null`).
- **Semantic hints, never coercion** — `epoch-ms`/`uuid`/`sha256`/`hex32`/`iso-date`
  annotate; the bytes are never reformatted.
- **`recordKind: "uniform"` only on full-stream exhaustion** — an all-object *sample*
  from an undrained stream is `"partial"`, never falsely "uniform" (that would be a
  confident-but-wrong success — the very Honest-Response sin).
- **Code-computed size-delta** — report bytes vs sampled bytes; if the report isn't
  smaller, it says so.

## Honest-Response everywhere

No empty-as-success. `data_shape`: "no array field — pass a pointer / use read_file",
lists candidates when ambiguous. `data_select`: clear messages for 0 matches,
all-null projection (wrong field names → run data_shape), scan truncation.

**Bundled fix:** `file_outline` previously parsed `.json/.yaml` but walked them with
the code-only extractor → returned empty-as-success while advertising support. Now it
returns an actionable error (use `read_file`/`data_shape`). Contained to
`file-outline.ts`; the shared `detectLanguage`/tree-sitter untouched.

## Sources & limits (v1)

- **JSON and JSONL/.log files.** Both are currently **read whole into memory**
  (`readFileSync`), then JSON-parsed (or line-split for JSONL) and *then* sampled —
  this is NOT yet true streaming. It's fine for in-tree sizes (largest log here is
  ~1.18 MB) and it keeps the *whole file out of the agent's context* (you only see
  the shape/projection), but it will not scale to a file too big to fit in RAM.
  JSONL tolerates malformed/torn lines (skips + notes the count); `.log` tries JSONL
  first, falls back to whole-file JSON.
- **Not yet (the "reach" tier — add when a consumer needs it, not speculatively):**
  true streaming for arrays/logs too big to fit in memory (wrap `stream-json`),
  `httpJson`/`stdin` sources, YAML, `--emit ts|zod|json-schema` (wrap `quicktype`).

## CCP compliance

Primary consumer: the agent (the two MCP tools). No bus events, no admin API — it
*reads* state files/HTTP, writes none. Pure read-only tools.

## Design history

`dependencies/data-lens/README.md` held the v1/v2 spec (now removed; this is the
shipped doc). Trail: `93023f33` (v1 spec) → adversarial review (verdict needs-work)
→ `007b09b7` (v2: wrap-not-build, dropped the tree-sitter registry refactor,
shipped the honesty fix) → `3cee0308` (`data_shape`) → `data_select` + this doc.
