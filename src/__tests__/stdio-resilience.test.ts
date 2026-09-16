/**
 * Integration tests for the ar-tools stdio entry point (src/stdio.ts).
 *
 * These spawn the REAL stdio server as a subprocess (the way a disableBuiltinTools
 * consumer's Claude CLI does) and exercise two invariants that, if they regress,
 * silently zero the agent's entire toolset:
 *   1. Happy path + stdout hygiene — initialize/tools/list work and stdout carries
 *      ONLY JSON-RPC frames (one stray non-JSON byte corrupts the stream).
 *   2. Fault resilience — a post-startup unhandledRejection/uncaughtException must
 *      NOT take the server down; it must keep answering requests.
 */
import { describe, it, expect } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, "../stdio.ts");
const faultFixture = resolve(here, "fixtures/inject-fault.mjs");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Harness {
  child: ChildProcessWithoutNullStreams;
  lines: Record<string, unknown>[];
  rawLines: string[];
  badLines: number;
  send: (obj: unknown) => void;
}

function launch(opts?: { env?: NodeJS.ProcessEnv; preImports?: string[] }): Harness {
  // Single-process invocation: `node --import tsx <entry>` runs the server in ONE
  // process (the in-process tsx loader). The `tsx` CLI binary instead spawns a
  // child to run the entry, which would put any --import fault fixture into the
  // guard-less wrapper, not the server — so the fault test must use this form.
  const args = ["--import", "tsx"];
  for (const u of opts?.preImports ?? []) args.push("--import", u);
  args.push(entry);
  const child = spawn(process.execPath, args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...opts?.env },
  }) as ChildProcessWithoutNullStreams;

  const lines: Record<string, unknown>[] = [];
  const rawLines: string[] = [];
  const state = { badLines: 0 };
  let buf = "";
  child.stdout.on("data", (d: Buffer) => {
    buf += d.toString();
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      rawLines.push(line);
      try { lines.push(JSON.parse(line)); } catch { state.badLines++; }
    }
  });
  child.stderr.on("data", () => { /* stderr is allowed to carry logs */ });

  return {
    child,
    lines,
    rawLines,
    get badLines() { return state.badLines; },
    send: (obj: unknown) => child.stdin.write(JSON.stringify(obj) + "\n"),
  } as Harness;
}

async function handshake(h: Harness): Promise<void> {
  h.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } } });
  await sleep(400);
  h.send({ jsonrpc: "2.0", method: "notifications/initialized" });
}

describe("ar-tools stdio server", () => {
  it("serves tools and keeps stdout pure JSON-RPC", async () => {
    const h = launch();
    try {
      await sleep(1500);
      await handshake(h);
      h.send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
      await sleep(1200);

      const init = h.lines.find((m) => m.id === 1) as { result?: { protocolVersion?: string } } | undefined;
      const tools = h.lines.find((m) => m.id === 2) as { result?: { tools?: unknown[] } } | undefined;

      expect(init?.result?.protocolVersion).toBeTruthy();
      expect(tools?.result?.tools?.length ?? 0).toBeGreaterThan(0);
      expect(h.badLines).toBe(0); // any non-JSON stdout line corrupts the frame
      expect(h.child.exitCode).toBeNull(); // still alive
    } finally {
      h.child.kill();
    }
  }, 15000);

  it("survives a post-startup unhandledRejection + uncaughtException and keeps serving", async () => {
    // Fault fires at FAULT_DELAY_MS after process start. Set it well past startup
    // so the faults land AFTER ready=true (a pre-ready fault is fatal by design —
    // that path is the startup-failure contract, tested implicitly by test #1).
    const FAULT_AT = 3500;
    const launchedAt = Date.now();
    const h = launch({
      env: { FAULT_DELAY_MS: String(FAULT_AT) },
      preImports: [pathToFileURL(faultFixture).href],
    });
    try {
      await sleep(1200);
      await handshake(h);
      h.send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });

      // Confirm the server is actually ready (answered a request) BEFORE the fault
      // window — otherwise the test proves nothing about post-ready survival.
      for (let t = 0; t < 20 && !h.lines.some((m) => m.id === 2); t++) await sleep(100);
      expect(h.lines.some((m) => m.id === 2)).toBe(true); // ready confirmed pre-fault
      expect(Date.now() - launchedAt).toBeLessThan(FAULT_AT); // ...and before the fault

      // Wait past both faults (unhandledRejection @ FAULT_AT, uncaughtException @ +300).
      while (Date.now() - launchedAt < FAULT_AT + 800) await sleep(100);

      // If the guards failed (missing or exit-on-fault), the child is dead by now.
      expect(h.child.exitCode).toBeNull();

      // And it must still be functional — answer a fresh tools/list AFTER the faults.
      h.send({ jsonrpc: "2.0", id: 99, method: "tools/list", params: {} });
      await sleep(1200);
      const toolsAfter = h.lines.find((m) => m.id === 99) as { result?: { tools?: unknown[] } } | undefined;
      expect(toolsAfter?.result?.tools?.length ?? 0).toBeGreaterThan(0);
      expect(h.badLines).toBe(0);
    } finally {
      h.child.kill();
    }
  }, 20000);
});
