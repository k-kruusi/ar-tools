import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

/**
 * Persistent shell sessions for `run_command`.
 *
 * ## Why
 *
 * `run_command` spawns a fresh shell per call, so the action space has amnesia. Measured on a
 * real session (2026-08-27): the same 78 `workspace.json` files were parsed from disk five
 * separate times across five python heredocs, because nothing could be carried between calls.
 * That is the cost this removes.
 *
 * This is the useful half of the "shadow REPL" in Alex Zhang's speculative programmatic tool
 * calling (alexzhang13.github.io/blog/2026/spec-ptc/) with the speculation deliberately left
 * out. Speculation buys wall-clock latency by spending tokens on work that may be discarded;
 * this fleet's constraint is context and verification, not latency, and the calls we would
 * most want overlapped (agent dispatch, file writes) are exactly the ones its purity allowlist
 * must refuse. Persistent state is the part that transfers.
 *
 * ## OFF BY DEFAULT — this is an A/B, not a migration
 *
 * Enabled only when `AR_TOOLS_REPL=1` AND the caller passes a `session`. With the flag off, or
 * with no `session`, `run_command` behaves exactly as before: a fresh shell, no shared state.
 * That keeps the comparison honest and means a wedged session can never become the default
 * failure mode.
 *
 * ## The hazards, and what is done about each
 *
 * A long-lived shell is a stateful thing in a fleet built on statelessness, so:
 *   - **A wedged command must not wedge the session forever.** Each command carries a sentinel
 *     echoed after it; on timeout the whole child is killed and the session dropped, so the
 *     next call starts clean rather than inheriting a half-consumed stream.
 *   - **`cd` persists, and that is the point but also a trap.** The working directory is
 *     reported back on every call so a caller can never be wrong about where it is.
 *   - **Sessions are process-scoped and idle-reaped.** They die with the MCP server and after
 *     IDLE_MS, because an abandoned shell holding a lock is worse than a cold start.
 *   - **stderr has no sentinel.** Only stdout can carry the completion marker, so stderr is
 *     whatever arrived before the marker was seen. A late-flushing stderr line can land in the
 *     NEXT call's output; that is disclosed rather than hidden, and is a reason to keep this
 *     off by default.
 */

const SENTINEL = "__AR_TOOLS_DONE__";
const IDLE_MS = 10 * 60_000;
const MAX_SESSIONS = 8;

export interface ReplResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  cwd: string;
  /** True when this call created the shell — the caller should say so; state starts empty. */
  created: boolean;
  /** Set when the session was killed rather than completing (timeout / crash). */
  died?: string;
}

interface Session {
  proc: ChildProcessWithoutNullStreams;
  out: string;
  err: string;
  busy: boolean;
  lastUsed: number;
  cwd: string;
}

const sessions = new Map<string, Session>();

export function replEnabled(): boolean {
  return process.env.AR_TOOLS_REPL === "1";
}

/** Session ids are used as map keys and echoed back; keep them boring. */
export function assertSessionName(name: string): void {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(name)) {
    throw new Error(
      `run_command: session must be 1-64 chars of letters, digits, dot, dash or underscore (got ${JSON.stringify(name)})`,
    );
  }
}

function reapIdle(): void {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (!s.busy && now - s.lastUsed > IDLE_MS) killSession(id);
  }
}

export function killSession(id: string): boolean {
  const s = sessions.get(id);
  if (!s) return false;
  sessions.delete(id);
  try { s.proc.kill("SIGKILL"); } catch { /* already gone — nothing to do */ }
  return true;
}

export function listSessions(): Array<{ id: string; cwd: string; idleMs: number; busy: boolean }> {
  return [...sessions].map(([id, s]) => ({
    id, cwd: s.cwd, idleMs: Date.now() - s.lastUsed, busy: s.busy,
  }));
}

function open(
  id: string,
  shell: { cmd: string; prefix: string[] },
  env: Record<string, string>,
  cwd: string,
): Session {
  reapIdle();
  if (sessions.size >= MAX_SESSIONS) {
    // Evict the coldest rather than refusing: a caller that names sessions freely should not
    // start getting errors, and the cost of eviction is one cold start.
    const coldest = [...sessions].filter(([, s]) => !s.busy).sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
    if (coldest) killSession(coldest[0]);
  }
  // Interactive-ish shell reading commands from stdin. `-s` is what makes bash read a stream.
  const proc = spawn(shell.cmd, shell.prefix.includes("-c") ? ["-s"] : [], {
    cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
  }) as ChildProcessWithoutNullStreams;
  const s: Session = { proc, out: "", err: "", busy: false, lastUsed: Date.now(), cwd };
  proc.stdout.on("data", (c: Buffer) => { s.out += c.toString("utf-8"); });
  proc.stderr.on("data", (c: Buffer) => { s.err += c.toString("utf-8"); });
  proc.on("close", () => sessions.delete(id));
  proc.on("error", () => sessions.delete(id));
  sessions.set(id, s);
  return s;
}

/**
 * Run one command in a named session, creating it if needed.
 *
 * The completion protocol is a sentinel echoed with `$?` after the command, which is the only
 * way to know a streamed shell finished without a pty: read stdout until the marker appears,
 * then everything before it is this command's output and the number after it is the exit code.
 */
export function runInSession(
  id: string,
  command: string,
  shell: { cmd: string; prefix: string[] },
  env: Record<string, string>,
  cwd: string,
  timeoutMs: number,
): Promise<ReplResult> {
  assertSessionName(id);
  const existing = sessions.get(id);
  const created = !existing;
  const s = existing ?? open(id, shell, env, cwd);

  if (s.busy) {
    return Promise.resolve({
      stdout: "", stderr: `session '${id}' is still running a previous command`,
      exitCode: 1, cwd: s.cwd, created: false,
    });
  }

  s.busy = true;
  s.out = "";
  s.err = "";
  // On the FIRST command only, honour the caller's cwd; afterwards the session owns it, which
  // is the whole point — a `cd` in call N is still in effect at call N+1.
  const prelude = created ? `cd ${JSON.stringify(cwd)} 2>/dev/null\n` : "";

  return new Promise<ReplResult>((resolveP) => {
    let settled = false;
    const finish = (r: ReplResult) => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      clearTimeout(timer);
      s.busy = false;
      s.lastUsed = Date.now();
      resolveP(r);
    };

    const timer = setTimeout(() => {
      const partial = s.out;
      const partialErr = s.err;
      killSession(id);
      finish({
        stdout: partial,
        stderr: `${partialErr}\nCommand timed out after ${timeoutMs}ms — SESSION '${id}' WAS KILLED, so its state is gone. The next call starts a fresh shell.`,
        exitCode: null, cwd: s.cwd, created, died: "timeout",
      });
    }, timeoutMs);

    // Poll rather than parse the stream incrementally: the sentinel can be split across
    // chunk boundaries, and re-scanning a bounded buffer is simpler than a streaming matcher.
    const poll = setInterval(() => {
      if (!sessions.has(id)) {
        finish({
          stdout: s.out, stderr: `${s.err}\nsession '${id}' exited unexpectedly`,
          exitCode: null, cwd: s.cwd, created, died: "exited",
        });
        return;
      }
      const m = new RegExp(`${SENTINEL}:(-?\\d+):(.*)$`, "m").exec(s.out);
      if (!m) return;
      const stdout = s.out.slice(0, m.index);
      s.cwd = (m[2] || s.cwd).trim() || s.cwd;
      finish({
        stdout, stderr: s.err, exitCode: Number(m[1]), cwd: s.cwd, created,
      });
    }, 25);

    // `pwd` rides along with the exit code so the caller is always told where the session is.
    s.proc.stdin.write(`${prelude}${command}\n__ar_rc=$?; echo "${SENTINEL}:$__ar_rc:$(pwd)"\n`);
  });
}
