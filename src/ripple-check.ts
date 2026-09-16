#!/usr/bin/env node
/**
 * ripple-check — post-commit structural-change detector (one-tree §3.5, Class B).
 *
 * Given a commit (default HEAD), find the code files it changed, run
 * export-level AST diffing on each (detectRippleInCommit), and for any
 * structural change — a renamed / re-signatured / deleted EXPORT — broadcast it
 * so other in-flight sessions learn their assumptions may have shifted:
 *   - print a human summary (captured by the post-commit hook into a local log)
 *   - best-effort emit `@agentruntime/coedit:structural` onto the supervisor bus
 *
 * Why this matters: CAS / git conflict detection only catches edits to the SAME
 * lines. Renaming an export breaks every file that used the old name with NO
 * textual conflict — the dependent files weren't even touched. This is the one
 * commit-time signal that catches that class.
 *
 * Usage: tsx src/ripple-check.ts [<commit-ref>]
 * Run from packages/tools/ so @agentruntime/tree-sitter resolves.
 */
import { execSync } from "node:child_process";
import { resolve } from "node:path";
import http from "node:http";
import { detectRippleInCommit } from "./lib/structural-diff.js";

const ref = process.argv[2] || "HEAD";
const SUPERVISOR_URL = process.env.SUPERVISOR_URL || "http://localhost:39827";

function git(args: string): string {
  return execSync(`git ${args}`, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
}

function changedCodeFiles(commit: string): string[] {
  let out: string;
  try {
    out = git(`diff --name-only ${commit}~1 ${commit}`);
  } catch {
    return [];
  }
  return out
    .trim()
    .split("\n")
    .filter((f) => /\.(ts|tsx|js|jsx|mjs|cjs|py)$/.test(f));
}

/** Best-effort bus emit. Never throws, short timeout, silent on failure
 *  (supervisor down, perimeter, offline — none of which should break a commit). */
function emitBus(payload: Record<string, unknown>): Promise<void> {
  return new Promise((done) => {
    let u: URL;
    try { u = new URL(`${SUPERVISOR_URL}/emit-event`); } catch { return done(); }
    const data = JSON.stringify({
      tag: "@agentruntime/coedit:structural",
      payload,
      caller: "ripple-check",
    });
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname,
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
        timeout: 3000,
      },
      (res) => { res.resume(); res.on("end", () => done()); },
    );
    req.on("error", () => done());
    req.on("timeout", () => { req.destroy(); done(); });
    req.write(data);
    req.end();
  });
}

async function main(): Promise<void> {
  let gitRoot: string;
  try {
    gitRoot = git("rev-parse --show-toplevel").trim();
  } catch {
    return; // not a repo — nothing to do
  }

  const files = changedCodeFiles(ref);
  if (files.length === 0) return;

  const sha = git(`rev-parse --short ${ref}`).trim();
  const stamp = git(`show -s --format=%cI ${ref}`).trim(); // committer date, ISO — field time, not session time
  let found = 0;

  for (const rel of files.slice(0, 50)) {
    const abs = resolve(gitRoot, rel);
    let ripple;
    try {
      ripple = await detectRippleInCommit(abs, `${ref}~1`, ref);
    } catch {
      continue;
    }
    if (!ripple) continue;

    // Additions alone don't ripple — only flag breaking shapes.
    const breaking = ripple.changes.filter((c) => c.kind !== "addition");
    if (breaking.length === 0) continue;

    found += breaking.length;
    console.log(`\n[coedit] structural change in ${rel} (commit ${sha}, ${stamp}):`);
    for (const c of breaking) console.log(`  ${c.kind}: ${c.detail}`);
    if (ripple.affected.length > 0) {
      console.log(`  ripples into ${ripple.affected.length} reference(s):`);
      for (const a of ripple.affected.slice(0, 15)) {
        console.log(`    ${a.file}:${a.line} -> ${a.usage}`);
      }
      if (ripple.affected.length > 15) console.log(`    ... and ${ripple.affected.length - 15} more`);
    }

    await emitBus({
      commit: sha,
      file: rel,
      at: stamp,
      changes: breaking.map((c) => ({ kind: c.kind, symbol: c.symbol, detail: c.detail })),
      affected: ripple.affected.slice(0, 50).map((a) => ({ file: a.file, line: a.line })),
      affectedCount: ripple.affected.length,
    });
  }

  if (found > 0) {
    console.log(`\n[coedit] ${found} structural change(s) in ${sha} broadcast on @agentruntime/coedit:structural.`);
    console.log(`[coedit] Sessions editing a rippled file: re-sense before you continue (skills/scent.md).`);
  }
}

main().catch(() => { /* never let analysis failure surface as a hook error */ });
