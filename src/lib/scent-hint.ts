//
// Why: agents grep by reflex and never meet the resident (ask_repo) until
// something forces them. Instead of forcing, the environment hands them the
// resident's orientation ambiently: the FIRST search result touching an area
// carries one line of testimony from the scent memo. The agent learns the
// trail exists by receiving it — stigmergy, not instruction.
//
// The memo (.repo-memory/cache/scent-memo.json) is written by the resident's
// incremental scent miner. It is ADVISORY here exactly as it is there:
// missing / torn / wrong-version → no hint, never an error, never latency.

import { readFileSync, statSync } from "node:fs";
import { join, relative, isAbsolute } from "node:path";
import { agentruntimeRoot } from "../utils.js";

interface ScentDeposit {
  path: string;
  agent: string;
  did: string;
  at: string;
  commit: string;
}

const MEMO_REL = join(".repo-memory", "cache", "scent-memo.json");
const MEMO_TTL_MS = 5 * 60_000;

let memoCache: { deposits: ScentDeposit[]; loadedAt: number; mtimeMs: number } | null = null;

// NSP, scoped to the boundary: a MISSING memo is legitimately absent (fresh box,
// resident never ran) and stays silent. A memo that EXISTS but can't be used —
// unsupported version, unparseable JSON — is a violated contract between colony
// components, and swallowing it is how the v1→v2 bump killed hints silently for
// 6 days. Warn loudly, out-of-band, once per process: the tool result a hint
// decorates must stay clean, but the operator's stderr must not.
let warnedBrokenMemo = false;
function warnOnce(reason: string): void {
  if (warnedBrokenMemo) return;
  warnedBrokenMemo = true;
  console.error(`[ar-tools] scent-memo unusable — ambient hints DISABLED (${reason}). Memo: ${MEMO_REL}`);
}

function deposits(): ScentDeposit[] {
  const path = join(agentruntimeRoot(), MEMO_REL);
  let mtimeMs: number;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    return memoCache?.deposits ?? []; // missing file: honestly absent, stay quiet
  }
  if (memoCache && memoCache.mtimeMs === mtimeMs && Date.now() - memoCache.loadedAt < MEMO_TTL_MS) {
    return memoCache.deposits;
  }
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as { version?: number; deposits?: ScentDeposit[] };
    // v1 and v2 share the deposit shape — v2 (resident's pickaxe fix, SCENT_MEMO_VERSION
    // bump to force a cold re-mine) only added `minedThrough` at the top level.
    if ((raw.version !== 1 && raw.version !== 2) || !Array.isArray(raw.deposits)) {
      warnOnce(`unsupported version ${raw.version} — this consumer speaks v1|v2; update scent-hint.ts to match the miner`);
      memoCache = { deposits: [], loadedAt: Date.now(), mtimeMs };
      return [];
    }
    memoCache = { deposits: raw.deposits, loadedAt: Date.now(), mtimeMs };
    return raw.deposits;
  } catch (e) {
    warnOnce(`unreadable: ${e instanceof Error ? e.message : String(e)}`);
    return memoCache?.deposits ?? [];
  }
}

/** The announce-once area of a repo-relative path: packages/<x>, dependencies/<x>,
 *  or the first segment (src, scripts, skills, …). null = outside the repo. */
function areaOf(repoRel: string): string | null {
  const parts = repoRel.replace(/\\/g, "/").split("/").filter(Boolean);
  if (!parts.length || parts[0].startsWith("..")) return null;
  if ((parts[0] === "packages" || parts[0] === "dependencies" || parts[0] === "cartridges") && parts.length > 1) {
    return `${parts[0]}/${parts[1]}`;
  }
  return parts[0];
}

// One announcement per area per server process — the hint is a doorbell, not
// a chaperone. (ar-tools stdio servers live one-per-agent-session, so process
// lifetime ≈ session lifetime.)
const announced = new Set<string>();

/**
 * One-line scent hints for the areas a search touched, each area only once
 * per session. `paths` may be absolute or repo-relative. Returns '' when
 * there is nothing new to say — callers prepend the result verbatim.
 */
export function scentHint(paths: string[]): string {
  const root = agentruntimeRoot();
  const areas = new Set<string>();
  for (const p of paths) {
    const rel = isAbsolute(p) ? relative(root, p) : p;
    const area = areaOf(rel);
    if (area && !announced.has(area)) areas.add(area);
  }
  if (!areas.size) return "";

  const lines: string[] = [];
  for (const area of areas) {
    announced.add(area); // even when no deposit exists — ask once, stay quiet after
    let newest: ScentDeposit | null = null;
    for (const d of deposits()) {
      // Skip template placeholders the miner picks up from scent.md's own
      // examples ("<your-handle>", "<one line, past tense…>") — angle brackets
      // never appear in a real agent handle or timestamp.
      if (d.agent.includes("<") || d.at.includes("<")) continue;
      if (d.path === area || d.path.startsWith(area + "/")) {
        if (!newest || d.at > newest.at) newest = d;
      }
    }
    if (newest) {
      const did = newest.did.length > 140 ? newest.did.slice(0, 137) + "…" : newest.did;
      lines.push(`[scent] ${area}: last worked by ${newest.agent} (${newest.at}) — "${did}" · quartz_context for what happened here`);
    }
    if (lines.length >= 2) break; // a hint, not a report
  }
  return lines.length ? lines.join("\n") + "\n\n" : "";
}
