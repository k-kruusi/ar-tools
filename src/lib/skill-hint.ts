/**
 * Just-in-time skill pointers.
 *
 * THE PROBLEM THIS SOLVES, stated by Kevin 2026-08-05: "an expert would know
 * about this; a novice would carry on and never trigger the event that would
 * promote the learning." A skill nobody reads first is a skill nobody reads.
 * Asking agents to consult a catalogue fails for exactly the agents who need it,
 * because not knowing the skill exists and not knowing to look are the same
 * state.
 *
 * WHY THIS SHAPE. The two hint mechanisms that landed in this colony both ride a
 * surface the agent cannot skip: `__mutate` writes into the tool description that
 * is already in context when you call the tool, and scent-hint.ts rides tool
 * results. The one that did not land (packages/context-fire) asked the agent to
 * FETCH a hint — 581 lines of Ed25519 relay, content-addressed publish and author
 * registry, to distribute skills between untrusted parties in a colony that is
 * one tree where every skill is already on disk. The hint index was the valuable
 * 10 lines; the distribution problem did not exist. So: no server, no crypto, no
 * publish step. Read the files, match the path, print one line.
 *
 * Contract — mirrors scentHint exactly:
 *   - zero-latency (disk read, cached for the process)
 *   - silent on any failure; a broken hint must never break a search
 *   - token-bounded: ONE line, and each skill announces at most once per session
 *   - returns '' when there is nothing to say; callers prepend verbatim
 *
 * HONEST LIMIT: path prefixes are a PROXY for the real trigger. The true trigger
 * for `assert_on` is "you are about to trust output you did not write," which is
 * a shape in the code, not a location. Path matching fires near that, not on it.
 * It is the cheap version that works today; content matching is the better rung
 * if this proves out.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { agentruntimeRoot } from "../utils.js";

interface SkillHint {
  /** repo-relative path prefix that arms this hint */
  path: string;
  /** what the agent is about to do — printed as the reason to read */
  when: string;
  /** skill filename, e.g. "assert_on.md" */
  skill: string;
}

let cache: SkillHint[] | null = null;

/**
 * Parse `hints:` out of a skill's YAML frontmatter without taking a YAML
 * dependency. The block shape is fixed and authored in this repo:
 *
 *   hints:
 *     - path: packages/tool-router
 *       when: wiring model output into a decision
 */
function parseHints(file: string, text: string): SkillHint[] {
  const block = text.match(/^hints:\s*$([\s\S]*?)^(?:\S|---\s*$)/m);
  if (!block) return [];
  const out: SkillHint[] = [];
  let current: Partial<SkillHint> = {};
  for (const raw of block[1].split("\n")) {
    const line = raw.trim();
    if (line.startsWith("- path:")) {
      if (current.path && current.when) out.push({ ...current, skill: file } as SkillHint);
      current = { path: line.slice("- path:".length).trim().replace(/^["']|["']$/g, "") };
    } else if (line.startsWith("when:")) {
      current.when = line.slice("when:".length).trim().replace(/^["']|["']$/g, "");
    }
  }
  if (current.path && current.when) out.push({ ...current, skill: file } as SkillHint);
  return out;
}

function hints(): SkillHint[] {
  if (cache) return cache;
  cache = [];
  try {
    const dir = join(agentruntimeRoot(), "skills");
    if (!existsSync(dir)) return cache;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".md")) continue;
      try {
        cache.push(...parseHints(f, readFileSync(join(dir, f), "utf-8")));
      } catch {
        // one unreadable skill must not blind the rest
      }
    }
  } catch {
    // no skills dir, unreadable root — stay silent, this is a doorbell
  }
  return cache;
}

/** Skills that have already rung this session — a doorbell, not a chaperone. */
const announced = new Set<string>();

/**
 * One skill pointer for the areas a search touched, each skill only once per
 * session. `paths` may be absolute or repo-relative. Returns '' when there is
 * nothing new to say — callers prepend the result verbatim.
 */
export function skillHint(paths: string[]): string {
  let all: SkillHint[];
  try {
    all = hints();
  } catch {
    return "";
  }
  if (!all.length) return "";

  const root = agentruntimeRoot();
  for (const p of paths) {
    if (!p) continue;
    let rel: string;
    try {
      rel = (isAbsolute(p) ? relative(root, p) : p).replace(/\\/g, "/");
    } catch {
      continue;
    }
    for (const h of all) {
      if (announced.has(h.skill)) continue;
      if (rel === h.path || rel.startsWith(h.path.replace(/\/$/, "") + "/")) {
        announced.add(h.skill);
        // ONE line, first match wins. A second pointer in the same result is a
        // reading list, and a reading list gets skipped exactly like the skill
        // catalogue this exists to replace.
        return `[skill] ${h.when} → read skills/${h.skill} first (once per session)\n\n`;
      }
    }
  }
  return "";
}
