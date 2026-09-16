/**
 * CCR (Compressed Content Recovery) chunk store — now a thin re-export.
 *
 * The implementation moved to `@agentruntime/ccr-store` (2026-07-30) because the
 * compression half of this mechanism was already a shared library (`token-funnel`'s
 * `funnelReversible`) while the RECOVERY half lived only here. That split meant
 * `packages/tools` was the one cartridge that could compress honestly: every other tool
 * returning bulk text — youtube-transcript, web-fetch — had to choose between blowing out
 * the caller's context and dropping content silently, because a `<<ccr:…>>` marker nobody
 * can expand is worse than a plain truncation. It claims recoverability.
 *
 * This file stays as the import seam so ar-tools' call sites and their existing test suite
 * are untouched, and so there is exactly ONE implementation rather than a copy per
 * consumer. The LRU semantics are unchanged (module-level store, persists across tool
 * calls in this long-lived SSE server). Two deliberate fixes came with the move, both in
 * the shared package:
 *
 *   - a malformed marker no longer becomes its own cache key. It used to fall back to
 *     `markerOrHash.trim()`, so `stash("<<ccr:zz>>")` wrote under the literal marker text
 *     and a later lookup by hash missed — making a typo'd reference and an evicted chunk
 *     both surface as `null`, indistinguishably.
 *   - the marker grammar is parsed by `token-funnel`, which mints it, so labelled markers
 *     (`<<ccr:HASH | 12 context lines · …>>`) resolve here without this file needing to
 *     know the grammar gained a label.
 *
 * Prefer importing from `@agentruntime/ccr-store` directly in new code.
 */

export {
  ccrStash,
  ccrRetrieve,
  ccrClearForTesting,
  ccrStoreSizeForTesting,
  createCcrStore,
  defaultCcrStore,
  parseCcrHash,
} from "@agentruntime/ccr-store";
export type { CcrStore, CcrLimits, CcrEntryView } from "@agentruntime/ccr-store";
