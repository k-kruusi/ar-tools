/**
 * The edit plane — a visible staging layer between an agent's decision to edit
 * and the bytes landing on the shared tree.
 *
 * WHY THIS EXISTS. Many agents edit one working tree concurrently. The window
 * where a collision is preventable sits between "I read the file" (turn N) and
 * "I write it" (turn N+1) — minutes later, on a tree that moved. No tool lived
 * in that window: a write simply clobbered, and the loss was discoverable only
 * as an after-the-fact git diff.
 *
 * WHY NOT OT/CRDT. Those exist to reconcile keystroke streams in real time.
 * Agents emit whole edits minutes apart and can afford to block, so the cheap
 * correct mechanism is optimistic concurrency against a read receipt, not
 * conflict-free replication. See papers/agentruntime/plans/edit-plane.md.
 *
 * THE SAFETY PROPERTY that makes this safe to default ON: with no pendings and
 * no stale receipt, planeWrite() is byte-identical to writeFileSync() plus one
 * small journal append. Contention only fires where today's behaviour is a
 * SILENT CLOBBER.
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { agentruntimeRoot } from "../utils.js";

export type PlaneStatus = "pending" | "landed" | "blocked" | "orphaned" | "discarded";

export interface PlaneEdit {
  id: string;
  agent: string;
  tool: string;
  path: string;
  at: string;
  why?: string;
  baseHash: string;
  afterHash: string;
  bytes: number;
  status: PlaneStatus;
  detail?: string;
}

/** Journal entries older than this are pruned on write. Keeps the plane small. */
const JOURNAL_MAX = 400;
/** A read receipt older than this is treated as no receipt (the agent has moved on). */
const RECEIPT_TTL_MS = 6 * 60 * 60 * 1000;

let seq = 0;

export function planeDir(): string {
  return join(agentruntimeRoot(), ".plane");
}

/**
 * Who is writing. ar-tools runs as a per-agent stdio child (CONTAINER_NAME set
 * by the supervisor) or as one shared SSE process (no such var) — hence the
 * cascade. An unattributable writer is named honestly rather than guessed at:
 * a wrong name in the journal is worse than "pid:N", because the colony would
 * chase the wrong agent.
 */
export function planeAgent(): string {
  return (
    process.env.AR_AGENT_ID ||
    process.env.CONTAINER_NAME ||
    process.env.AI_AGENT ||
    `pid:${process.pid}`
  );
}

export function sha(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * The plane governs the SHARED TREE and nothing else.
 *
 * An edit to a temp dir, a scratch file, or anywhere outside the agentruntime
 * root has no colony meaning: nobody else is reading it, so a receipt cannot
 * prevent a collision and a journal line is pure noise. Found live — the
 * package's own edit-tool tests write to tmp dirs and filled the production
 * journal with 40 entries, crowding out the real "recently landed" signal that
 * read_file's banner is built from.
 */
export function governedByPlane(path: string): boolean {
  try {
    const rel = relative(agentruntimeRoot(), path);
    return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  } catch {
    return false;
  }
}

function ensureDirs(): { pending: string; reads: string } {
  const pending = join(planeDir(), "pending");
  const reads = join(planeDir(), "reads");
  mkdirSync(pending, { recursive: true });
  mkdirSync(reads, { recursive: true });
  return { pending, reads };
}

/** Atomic-ish write: tmp + rename, so a concurrent reader never sees a half file. */
function writeAtomic(target: string, data: string): void {
  const tmp = `${target}.${process.pid}.${seq++}.tmp`;
  writeFileSync(tmp, data, "utf-8");
  renameSync(tmp, target);
}

function nextId(agent: string): string {
  return `${Date.now().toString(36)}-${agent.replace(/[^\w.-]/g, "_")}-${process.pid}-${seq++}`;
}

function shortPath(p: string): string {
  try {
    const rel = relative(agentruntimeRoot(), p);
    return rel.startsWith("..") ? p : rel.replace(/\\/g, "/");
  } catch {
    return p;
  }
}

// ---------- journal ----------

function journalPath(): string {
  return join(planeDir(), "edits.jsonl");
}

function appendJournal(edit: PlaneEdit): void {
  try {
    mkdirSync(planeDir(), { recursive: true });
    appendFileSync(journalPath(), JSON.stringify(edit) + "\n", "utf-8");
    pruneJournal();
  } catch {
    // The journal is an observability surface, not the mechanism. Losing a line
    // must never fail the edit that was otherwise safe to land.
  }
}

function pruneJournal(): void {
  try {
    const p = journalPath();
    if (!existsSync(p)) return;
    if (statSync(p).size < 512 * 1024) return;
    const lines = readFileSync(p, "utf-8").split("\n").filter(Boolean);
    if (lines.length <= JOURNAL_MAX) return;
    writeAtomic(p, lines.slice(-JOURNAL_MAX).join("\n") + "\n");
  } catch {
    /* best-effort */
  }
}

export function readJournal(limit = 60): PlaneEdit[] {
  try {
    const p = journalPath();
    if (!existsSync(p)) return [];
    const lines = readFileSync(p, "utf-8").split("\n").filter(Boolean);
    const out: PlaneEdit[] = [];
    for (const line of lines.slice(-limit)) {
      try {
        out.push(JSON.parse(line) as PlaneEdit);
      } catch {
        /* skip a torn line rather than failing the whole read */
      }
    }
    return out;
  } catch {
    return [];
  }
}

// ---------- read receipts ----------

interface Receipt {
  hash: string;
  at: number;
}

function receiptFile(agent: string): string {
  return join(planeDir(), "reads", `${agent.replace(/[^\w.-]/g, "_")}.json`);
}

function loadReceipts(agent: string): Record<string, Receipt> {
  try {
    const f = receiptFile(agent);
    if (!existsSync(f)) return {};
    return JSON.parse(readFileSync(f, "utf-8")) as Record<string, Receipt>;
  } catch {
    return {};
  }
}

/**
 * Record that `agent` has seen these exact bytes of `path`. This is the half
 * that makes contention detectable at all: the staleness window is between an
 * agent's read and its write, so the read is what must be remembered.
 */
export function recordRead(path: string, content: string): void {
  if (!governedByPlane(path)) return;
  try {
    ensureDirs();
    const agent = planeAgent();
    const all = loadReceipts(agent);
    all[path] = { hash: sha(content), at: Date.now() };
    // Bound the file: keep the 200 most recent reads.
    const entries = Object.entries(all).sort((a, b) => b[1].at - a[1].at).slice(0, 200);
    writeAtomic(receiptFile(agent), JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // No receipt just means the next write can't be checked — degrade to
    // today's behaviour rather than failing the read.
  }
}

function getReceipt(path: string): Receipt | null {
  const r = loadReceipts(planeAgent())[path];
  if (!r) return null;
  if (Date.now() - r.at > RECEIPT_TTL_MS) return null;
  return r;
}

// ---------- pendings ----------

function pendingContentFile(id: string): string {
  return join(planeDir(), "pending", `${id}.content`);
}
function pendingMetaFile(id: string): string {
  return join(planeDir(), "pending", `${id}.json`);
}

export function listPendings(path?: string): PlaneEdit[] {
  try {
    const dir = join(planeDir(), "pending");
    if (!existsSync(dir)) return [];
    const out: PlaneEdit[] = [];
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      try {
        const e = JSON.parse(readFileSync(join(dir, f), "utf-8")) as PlaneEdit;
        // A landed/discarded record may survive its delete (Windows can refuse
        // to unlink a just-renamed file). Status is the authority, not the
        // file's existence — otherwise a failed cleanup resurrects a pending
        // edit that already landed, and someone lands it twice.
        if (e.status === "landed" || e.status === "discarded") continue;
        if (!path || e.path === path) out.push(e);
      } catch {
        /* skip unparseable */
      }
    }
    return out.sort((a, b) => a.at.localeCompare(b.at));
  } catch {
    return [];
  }
}

function savePending(edit: PlaneEdit, content: string): void {
  ensureDirs();
  writeAtomic(pendingContentFile(edit.id), content);
  writeAtomic(pendingMetaFile(edit.id), JSON.stringify(edit, null, 2));
}

export function dropPending(id: string): void {
  for (const f of [pendingContentFile(id), pendingMetaFile(id)]) {
    try {
      rmSync(f, { force: true });
    } catch {
      /* best-effort */
    }
  }
}

export function pendingContent(id: string): string | null {
  try {
    return readFileSync(pendingContentFile(id), "utf-8");
  } catch {
    return null;
  }
}

// ---------- the projection ----------

/**
 * The banner read_file prepends when a path has plane activity. This is the
 * "visible before real" half: an agent reading a contended file learns about
 * in-flight work it would otherwise only discover by clobbering it.
 */
export function planeBanner(path: string): string {
  if (!governedByPlane(path)) return "";
  const me = planeAgent();
  const pendings = listPendings(path);
  const recent = readJournal(60).filter(
    (e) => e.path === path && e.status === "landed" && e.agent !== me,
  );

  const parts: string[] = [];
  if (pendings.length > 0) {
    parts.push(
      `── ${pendings.length} PENDING edit(s) on the plane (not yet on disk) ──\n` +
        pendings
          .map(
            (e) =>
              `  ${e.id}  ${e.agent} via ${e.tool} at ${e.at}` +
              (e.why ? `\n    why: ${e.why}` : "") +
              (e.status === "blocked" ? `\n    BLOCKED: ${e.detail ?? "stale base"}` : ""),
          )
          .join("\n") +
        `\n  The content below is what is ON DISK. Use plane_show <id> to read a pending version.`,
    );
  }
  if (recent.length > 0) {
    const last = recent[recent.length - 1];
    parts.push(
      `── recently landed by another agent ──\n  ${last.agent} via ${last.tool} at ${last.at}` +
        (last.why ? `\n  why: ${last.why}` : ""),
    );
  }
  return parts.length ? parts.join("\n\n") + "\n\n" : "";
}

// ---------- the write path ----------

export interface PlaneWriteOpts {
  tool: string;
  /** Content the caller based its edit on (what it read microseconds ago). */
  base: string | null;
  why?: string;
  /** Stage only — do not touch disk. Land later with land_edits. */
  hold?: boolean;
}

export interface PlaneWriteResult {
  ok: boolean;
  status: PlaneStatus;
  id: string;
  message: string;
}

/**
 * The single seam every ar-tools write passes through.
 *
 * Order matters: the receipt check runs BEFORE the bytes move, because the
 * whole point is to refuse rather than to report damage afterwards.
 */
export function planeWrite(
  path: string,
  updated: string,
  opts: PlaneWriteOpts,
): PlaneWriteResult {
  // Outside the shared tree the plane has no jurisdiction: write and say nothing.
  if (!governedByPlane(path)) {
    writeFileSync(path, updated, "utf-8");
    return { ok: true, status: "landed", id: "ungoverned", message: "" };
  }

  const agent = planeAgent();
  const id = nextId(agent);
  const onDisk = existsSync(path) ? readFileSync(path, "utf-8") : null;
  const diskHash = onDisk === null ? "absent" : sha(onDisk);

  const edit: PlaneEdit = {
    id,
    agent,
    tool: opts.tool,
    path,
    at: new Date().toISOString(),
    why: opts.why,
    baseHash: opts.base === null ? "absent" : sha(opts.base),
    afterHash: sha(updated),
    bytes: Buffer.byteLength(updated, "utf-8"),
    status: "pending",
  };

  // 1. Did the tree move under the caller since IT read this file?
  //    The in-call base always matches disk (they are microseconds apart) — the
  //    real staleness window is the agent's read_file, minutes earlier. That is
  //    what the receipt remembers, and what is checked here.
  const receipt = getReceipt(path);
  if (receipt && onDisk !== null && receipt.hash !== diskHash) {
    const culprits = readJournal(60).filter(
      (e) => e.path === path && e.status === "landed" && e.agent !== agent,
    );
    const who = culprits.length
      ? `${culprits[culprits.length - 1].agent} (via ${culprits[culprits.length - 1].tool}, ${culprits[culprits.length - 1].at})` +
        (culprits[culprits.length - 1].why ? ` — "${culprits[culprits.length - 1].why}"` : "")
      : "an unattributed writer (git checkout, an editor, or a build script)";

    edit.status = "blocked";
    edit.detail = `disk changed since your read_file; last landed by ${who}`;
    savePending(edit, updated);
    appendJournal(edit);
    return {
      ok: false,
      status: "blocked",
      id,
      message:
        `REFUSED — ${shortPath(path)} changed since you read it.\n` +
        `  last landed by: ${who}\n` +
        `  your edit is SAFE on the plane as ${id} (nothing was overwritten).\n` +
        `  Re-read the file, then either redo the edit against current bytes or\n` +
        `  land yours anyway with land_edits(id="${id}", force=true) if you are sure.`,
    };
  }

  // 2. Staged write — the caller wants a multi-file transaction.
  if (opts.hold) {
    savePending(edit, updated);
    appendJournal(edit);
    return {
      ok: true,
      status: "pending",
      id,
      message:
        `STAGED on the plane as ${id} — ${shortPath(path)} is UNCHANGED on disk.\n` +
        `  Land it with land_edits(id="${id}") (or land_edits() for all of yours).`,
    };
  }

  // 3. Land.
  writeFileSync(path, updated, "utf-8");
  edit.status = "landed";
  appendJournal(edit);
  // The author's own view is now current — refresh the receipt so their next
  // edit in the same turn isn't refused by their own landed change.
  recordRead(path, updated);
  return { ok: true, status: "landed", id, message: "" };
}

/** Apply staged pendings. Each is re-checked against disk at land time. */
export function planeLand(
  opts: { id?: string; force?: boolean } = {},
): { landed: PlaneEdit[]; refused: Array<{ edit: PlaneEdit; reason: string }> } {
  const me = planeAgent();
  const all = listPendings().filter((e) => (opts.id ? e.id === opts.id : e.agent === me));
  const landed: PlaneEdit[] = [];
  const refused: Array<{ edit: PlaneEdit; reason: string }> = [];

  for (const edit of all) {
    const content = pendingContent(edit.id);
    if (content === null) {
      refused.push({ edit, reason: "pending content missing (plane corrupted or pruned)" });
      continue;
    }
    const onDisk = existsSync(edit.path) ? readFileSync(edit.path, "utf-8") : null;
    const diskHash = onDisk === null ? "absent" : sha(onDisk);

    // Orphan check: the bytes this edit was computed against are gone.
    if (!opts.force && edit.baseHash !== "absent" && diskHash !== edit.baseHash) {
      edit.status = "orphaned";
      edit.detail = `base ${edit.baseHash.slice(0, 12)} no longer on disk (now ${diskHash.slice(0, 12)})`;
      savePending(edit, content);
      appendJournal(edit);
      refused.push({ edit, reason: edit.detail });
      continue;
    }

    writeFileSync(edit.path, content, "utf-8");
    edit.status = "landed";
    appendJournal(edit);
    // Mark BEFORE unlinking: if the delete fails, the record still reads as
    // landed and listPendings filters it out.
    try {
      savePending(edit, content);
    } catch {
      /* the drop below is the normal path */
    }
    dropPending(edit.id);
    recordRead(edit.path, content);
    landed.push(edit);
  }
  return { landed, refused };
}
