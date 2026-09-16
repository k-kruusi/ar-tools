import { resolve, dirname, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";

/**
 * The agentruntime monorepo root — the shared, predictable base directory that
 * all tools resolve relative paths and default working directories against.
 *
 * Why not process.cwd()? The tools server is a SINGLE shared process serving
 * many agents over SSE; its process.cwd() is its own cartridge dir
 * (cartridges/ar-tools), which is meaningless to callers. The monorepo root is
 * the one location every agent shares and does real work in (git, builds,
 * packages/…), so it is the sane default when no explicit dir is given.
 *
 * Resolution order:
 *   1. $AGENTRUNTIME_ROOT, verified by an agentruntime.json marker
 *   2. walk up from process.cwd() looking for agentruntime.json
 *   3. process.cwd() as a last resort — logged, so it is never a silent surprise
 *
 * Memoized: the root does not change over a process lifetime.
 */
let cachedRoot: string | null = null;

export function agentruntimeRoot(): string {
  if (cachedRoot) return cachedRoot;

  const env = process.env.AGENTRUNTIME_ROOT;
  if (env && existsSync(join(env, "agentruntime.json"))) {
    cachedRoot = resolve(env);
    return cachedRoot;
  }

  let dir = process.cwd();
  for (let i = 0; i < 40; i++) {
    if (existsSync(join(dir, "agentruntime.json"))) {
      cachedRoot = dir;
      return cachedRoot;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  console.warn(
    `[tools] Could not locate agentruntime.json (AGENTRUNTIME_ROOT=${env ?? "unset"}); ` +
      `falling back to process.cwd()=${process.cwd()} as the base dir.`,
  );
  cachedRoot = process.cwd();
  return cachedRoot;
}

/**
 * Normalize a file/dir path for cross-platform safety, resolving relative paths
 * against the agentruntime root (NOT the server's process.cwd()).
 *
 * On Windows, backslash paths passed through JSON-RPC / MCP SSE transport
 * can get double-unescaped, turning `D:\foo\bar` into `D:foobar`.
 *
 * Git Bash and MSYS2 use POSIX-style drive paths: /d/foo → D:\foo.
 * Node's path.resolve on Windows treats /d/foo as "d" directory at drive root,
 * producing D:\d\foo — silently wrong. This detects the POSIX pattern and
 * converts to a proper Windows drive letter before resolving.
 *
 * Absolute paths are returned as-is (resolve ignores the base); relative paths
 * resolve against `base` (default: the agentruntime root).
 *
 * Callers should always pass paths through this before using them.
 */
export function normalizePath(inputPath: string, base: string = agentruntimeRoot()): string {
  let p = inputPath;

  // Convert POSIX-style drive paths: /c/foo → C:\foo, /d/bar → D:\bar
  if (process.platform === "win32") {
    const posixDrive = p.match(/^\/([a-zA-Z])\//);
    if (posixDrive) {
      p = `${posixDrive[1].toUpperCase()}:\\${p.slice(3).replace(/\//g, "\\")}`;
    }
  }

  return resolve(base, p);
}

/**
 * Directory names to skip when grep_search falls back to plain recursive grep /
 * findstr (i.e. when ripgrep isn't installed). Ripgrep honors .gitignore natively
 * and skips these for free; the fallbacks DON'T — they crawl the whole tree, which
 * here means dist/, data/, projects/ (spawned workspaces), checkpoints, .soul/,
 * .memory/ … A whole-tree fallback grep over that territory timed out at the kill
 * limit (the friction this fixes). We derive the skip list from the agentruntime
 * root's .gitignore — every entry that is an explicit, single-segment directory
 * (ends in "/", no globs, no nested path) — plus a node_modules/.git floor. git
 * grep --exclude-dir and findstr filtering both match on the directory basename, so
 * single-segment names are exactly what's portable across both. Memoized.
 */
let cachedIgnoreDirs: string[] | null = null;

export function gitignoreDirs(): string[] {
  if (cachedIgnoreDirs) return cachedIgnoreDirs;
  const dirs = new Set<string>(["node_modules", ".git"]);
  try {
    const gi = readFileSync(join(agentruntimeRoot(), ".gitignore"), "utf-8");
    for (const raw of gi.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      if (!line.endsWith("/")) continue; // only explicit directory entries
      const name = line.replace(/^\/+/, "").replace(/\/+$/, "");
      if (!name || /[*?[\]!/]/.test(name)) continue; // skip globs and nested paths
      dirs.add(name);
    }
  } catch {
    /* no .gitignore (or unreadable) — the node_modules/.git floor still applies */
  }
  cachedIgnoreDirs = [...dirs];
  return cachedIgnoreDirs;
}

/**
 * On Windows, locate the Git-for-Windows install root. Git bundles a full POSIX
 * toolchain (bash, grep, sed, awk, head, …) under bin/ and usr/bin/ — even when
 * none of it is on PATH. We use this to:
 *   - run shell commands through git bash (matching the POSIX shell agents are
 *     trained on) instead of cmd.exe, and
 *   - give grep_search a real GNU `grep` fallback (full regex + --exclude-dir)
 *     when ripgrep isn't installed, instead of the crippled findstr.
 * Returns null on non-Windows, or if Git isn't found. Memoized.
 */
let cachedGitRoot: string | null | undefined = undefined;

export function gitRoot(): string | null {
  if (cachedGitRoot !== undefined) return cachedGitRoot;
  if (process.platform !== "win32") {
    cachedGitRoot = null;
    return null;
  }

  const candidates: string[] = [];
  if (process.env.AR_TOOLS_GIT_ROOT) candidates.push(process.env.AR_TOOLS_GIT_ROOT);
  candidates.push("C:\\Program Files\\Git", "C:\\Program Files (x86)\\Git");
  try {
    const out = execSync("where git", {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .trim()
      .split(/\r?\n/)[0]
      ?.trim();
    // ...\Git\cmd\git.exe -> ...\Git
    if (out) candidates.push(resolve(dirname(out), ".."));
  } catch {
    /* git not on PATH — fall back to the fixed candidate locations */
  }

  for (const c of candidates) {
    if (c && existsSync(join(c, "bin", "bash.exe"))) {
      cachedGitRoot = c;
      return c;
    }
  }
  cachedGitRoot = null;
  return null;
}

/**
 * Full path to a Git-bundled POSIX tool (e.g. "grep.exe", "bash.exe"), or null
 * if Git isn't present. Checks usr/bin then bin.
 */
export function gitTool(exe: string): string | null {
  const root = gitRoot();
  if (!root) return null;
  for (const sub of ["usr\\bin", "bin"]) {
    const p = join(root, sub, exe);
    if (existsSync(p)) return p;
  }
  return null;
}
