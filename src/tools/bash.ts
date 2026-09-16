import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { z } from "zod";
import { funnelReversible, classifyCommand } from "@agentruntime/token-funnel";
import { ccrStash } from "../lib/ccr-store.js";
import { scrubToolOutput } from "../scrub-util.js";
import { replEnabled, runInSession } from "../lib/repl-session.js";
import { normalizePath, agentruntimeRoot, gitRoot } from "../utils.js";
import { abSample } from "../lib/ab-report.js";

const MAX_OUTPUT = 50_000;
const DEFAULT_TIMEOUT = 300_000;

/**
 * Resolve the shell to run commands through.
 *
 * On Windows we PREFER Git bash. Git-for-Windows bundles a full POSIX toolchain
 * (pipes, grep, sed, awk, head, …), and agents are trained on POSIX shell — so
 * cmd.exe actively fights them: quoting breaks (`node -e`, inline scripts), there
 * are no pipes/globs/`head`, multi-term findstr fails, and a space-containing exe
 * path can't even be invoked. We fall back to cmd.exe only when Git bash is absent.
 *
 * Using spawn(bash, ["-c", command]) (no shell:true) passes the command to bash
 * verbatim — there is no cmd.exe layer to double-escape quotes. Memoized.
 */
let cachedShell: { cmd: string; prefix: string[]; pathPrepend: string | null } | null = null;

function resolveShell(): { cmd: string; prefix: string[]; pathPrepend: string | null } {
  if (cachedShell) return cachedShell;
  if (process.platform !== "win32") {
    cachedShell = { cmd: "/bin/bash", prefix: ["-c"], pathPrepend: null };
    return cachedShell;
  }
  const root = gitRoot();
  if (root) {
    cachedShell = {
      cmd: join(root, "bin", "bash.exe"),
      prefix: ["-c"],
      // Make the bundled coreutils (grep, sed, head, …) available on PATH inside
      // the non-login shell that spawn() creates.
      pathPrepend: `${join(root, "usr", "bin")};${join(root, "bin")}`,
    };
    return cachedShell;
  }
  cachedShell = { cmd: "cmd.exe", prefix: ["/c"], pathPrepend: null };
  return cachedShell;
}

/**
 * Build the child env, prepending git's POSIX dirs to PATH when running git bash.
 *
 * IMPORTANT: on Windows the env var is usually keyed "Path" (not "PATH"), and a
 * spread copy of process.env is a plain, case-SENSITIVE object — so reading
 * `env.PATH` would be undefined and clobbering it would drop node/npm/python/etc.
 * from the child's PATH (only git's tools would remain). So we find the real key
 * case-insensitively and prepend to it, preserving the inherited PATH.
 */
export function buildShellEnv(
  base: NodeJS.ProcessEnv,
  pathPrepend: string | null,
): Record<string, string> {
  const env = { ...base } as Record<string, string>;
  if (!pathPrepend) return env;
  const pathKey = Object.keys(env).find((k) => k.toLowerCase() === "path") ?? "PATH";
  env[pathKey] = `${pathPrepend};${env[pathKey] ?? ""}`;
  return env;
}

function execCommand(
  command: string,
  cwd?: string,
  timeoutMs = DEFAULT_TIMEOUT,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolveP) => {
    const sh = resolveShell();
    const env = buildShellEnv(process.env, sh.pathPrepend);

    const proc = spawn(sh.cmd, [...sh.prefix, command], {
      cwd: cwd || process.cwd(),
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    proc.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    proc.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      resolveP({
        stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
        stderr: `Command timed out after ${timeoutMs}ms`,
        exitCode: null,
      });
    }, timeoutMs);

    proc.on("close", (code) => {
      clearTimeout(timer);
      resolveP({
        stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
        stderr: Buffer.concat(stderrChunks).toString("utf-8"),
        exitCode: code,
      });
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      resolveP({ stdout: "", stderr: `Failed to start: ${err.message}`, exitCode: 1 });
    });
  });
}

export function registerBash(server: McpServer): void {
  server.tool(
    "run_command",
    "Execute a shell command and return its output. On Windows runs via Git bash when available (POSIX: pipes, grep, sed, head, …), otherwise cmd.exe; /bin/bash on Linux/macOS. Default timeout is 5 minutes; pass timeout_ms (up to 600000 = 10min) for longer builds/installs/test suites.",
    {
      command: z.string().describe("The shell command to execute"),
      cwd: z.string().optional().describe("Working directory — absolute, or relative to the agentruntime root. Defaults to the agentruntime root."),
      timeout_ms: z.number().optional().describe("Timeout in ms (default: 300000 = 5min, max: 600000 = 10min). Builds, installs, and test suites often need 5-10 minutes — raise this rather than retrying on timeout."),
      session: z.string().optional().describe(
        "EXPERIMENTAL, requires AR_TOOLS_REPL=1. Name a persistent shell: variables, imports, "
        + "loaded data and the working directory survive to your next run_command with the same "
        + "name, so you stop re-reading the same files every call. Omit for the default "
        + "fresh-shell behaviour, which is unchanged. A timeout KILLS the session and its state.",
      ),
    },
    async ({ command, cwd: rawCwd, timeout_ms, session }) => {
      const cwd = rawCwd ? normalizePath(rawCwd) : agentruntimeRoot();
      const timeout = Math.min(timeout_ms || DEFAULT_TIMEOUT, 600_000);
      console.error(`[run_command]${session ? ` [session:${session}]` : ""} ${command}${cwd ? ` (cwd: ${cwd})` : ""}`);

      // A/B BOUNDARY. Session mode requires BOTH the flag and an explicit name; anything else
      // takes the original path untouched, so the control arm cannot drift.
      let replNote = "";
      const startedAt = Date.now();
      const useRepl = Boolean(session) && replEnabled();
      if (session && !replEnabled()) {
        // Honest Response: a silently-ignored session param would look like the feature worked
        // and produce a fresh shell whose lost state the caller would blame on their own code.
        return {
          content: [{
            type: "text" as const,
            text: `run_command: 'session' was passed but AR_TOOLS_REPL is not set, so persistent
sessions are OFF and this command was NOT run. Either set AR_TOOLS_REPL=1 in the cartridge's
workspace.json env and restart it, or drop the session parameter to use a fresh shell.`,
          }],
          isError: true,
        };
      }

      const result = useRepl
        ? await (async () => {
          const sh = resolveShell();
          const r = await runInSession(
            session as string, command, sh,
            buildShellEnv(process.env, sh.pathPrepend), cwd, timeout,
          );
          replNote = [
            r.created ? `[session '${session}' STARTED — state begins empty]` : `[session '${session}' — state carried over]`,
            `[cwd: ${r.cwd}]`,
            r.died ? `[session died: ${r.died}]` : "",
          ].filter(Boolean).join(" ");
          return { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode };
        })()
        : await execCommand(command, cwd, timeout);
      const parts: string[] = [];

      // null exitCode = timed out / killed mid-run — that is a failure, not a
      // success. Flagging it isError so a timeout can't read as a clean result.
      const isError = result.exitCode !== 0;
      const hint = classifyCommand(command);

      // Scrub secrets BEFORE compression (spec: scrub then compress).
      // Honest Response: disclose any redactions in the output.
      const stdoutScrub = scrubToolOutput(result.stdout);
      const stderrScrub = scrubToolOutput(result.stderr);

      // labelMarkers: a bare <<ccr:HASH>> tells the model a span exists but nothing about
      // it, so expanding is a coin flip — the usual outcome is that recoverable output is
      // simply never recovered. The label ("18 context lines · npm warn deprecated …") is
      // computed from the classification already done, so it costs no extra pass.
      if (stdoutScrub.text) {
        const funneled = funnelReversible(stdoutScrub.text, hint, { maxChars: MAX_OUTPUT, isError, labelMarkers: true });
        parts.push(funneled.text);
        ccrStash(funneled.stashed);
      }
      if (stderrScrub.text) {
        const funneled = funnelReversible(stderrScrub.text, hint, { maxChars: MAX_OUTPUT, isError, labelMarkers: true });
        parts.push(`[stderr]\n${funneled.text}`);
        ccrStash(funneled.stashed);
      }
      if (result.exitCode !== null && result.exitCode !== 0) parts.push(`[exit code: ${result.exitCode}]`);
      if (result.exitCode === null) parts.push("[process killed / timed out]");

      // A/B sample. BOTH arms report — the control ("fresh") is emitted whenever AR_TOOLS_AB
      // is on, including when AR_TOOLS_REPL is off, because an experiment where only the
      // treatment records has nothing to compare against.
      abSample({
        experiment: "ar-tools-repl",
        arm: useRepl ? "session" : "fresh",
        value: Date.now() - startedAt,
        tool: "run_command",
        outcome: isError ? "error" : "ok",
        meta: { chars: parts.join("").length, cmd: command.slice(0, 80) },
      });

      if (replNote) parts.push(replNote);
      const scrubNotes = [stdoutScrub.note, stderrScrub.note].filter(Boolean);
      if (scrubNotes.length > 0) parts.push(scrubNotes.join("\n"));

      return {
        content: [{ type: "text" as const, text: parts.join("\n\n") || "(no output)" }],
        ...(isError ? { isError: true } : {}),
      };
    },
  );
}
