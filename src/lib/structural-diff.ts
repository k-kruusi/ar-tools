import { execSync } from "node:child_process";
import { dirname, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { join, extname } from "node:path";
import {
  init,
  getExports,
  getImports,
  detectLanguage,
  type ExportInfo,
} from "@agentruntime/tree-sitter";

export interface StructuralChange {
  // "signature" = same name+kind, different parameter list/return type.
  // "kind"      = same name, category changed (function -> class, etc.).
  // "rename"    = an export disappeared and one of identical kind+signature
  //               appeared; dependents still reference the OLD name.
  kind: "signature" | "kind" | "rename" | "deletion" | "addition";
  symbol: string;
  detail: string;
}

export interface AffectedFile {
  file: string;
  line: number;
  usage: string;
}

export interface RippleResult {
  changes: StructuralChange[];
  affected: AffectedFile[];
}

export async function detectRipple(filePath: string): Promise<RippleResult | null> {
  const lang = detectLanguage(filePath);
  if (!lang || lang === "json" || lang === "yaml") return null;

  await init();

  const beforeSource = getGitVersion(filePath);
  if (!beforeSource) return null;

  let beforeExports: ExportInfo[];
  let afterExports: ExportInfo[];

  try {
    afterExports = await getExports(filePath);
  } catch {
    return null;
  }

  try {
    beforeExports = await getExportsFromSource(beforeSource, filePath, lang);
  } catch {
    return null;
  }

  const changes = diffExports(beforeExports, afterExports);
  if (changes.length === 0) return null;

  const changedNames = changes
    .filter((c) => c.kind !== "addition")
    .map((c) => c.symbol);
  const affected = changedNames.length > 0
    ? await findAffectedFiles(filePath, changedNames)
    : [];

  return { changes, affected };
}

/**
 * Like detectRipple, but compares two git revisions of a file instead of
 * working-tree-vs-HEAD. This is what a post-commit hook wants: "what structural
 * change did the commit I just made introduce, and who does it ripple to?"
 * beforeRef defaults to the commit's parent, afterRef to the commit itself.
 */
export async function detectRippleInCommit(
  filePath: string,
  beforeRef = "HEAD~1",
  afterRef = "HEAD"
): Promise<RippleResult | null> {
  const lang = detectLanguage(filePath);
  if (!lang || lang === "json" || lang === "yaml") return null;

  await init();

  const afterSource = getGitVersionAt(filePath, afterRef);
  if (afterSource === null) return null; // deleted at afterRef — nothing to parse
  const beforeSource = getGitVersionAt(filePath, beforeRef); // null = file is new

  let afterExports: ExportInfo[];
  try {
    afterExports = await getExportsFromSource(afterSource, filePath, lang);
  } catch {
    return null;
  }

  let beforeExports: ExportInfo[];
  try {
    beforeExports = beforeSource === null
      ? []
      : await getExportsFromSource(beforeSource, filePath, lang);
  } catch {
    return null;
  }

  const changes = diffExports(beforeExports, afterExports);
  if (changes.length === 0) return null;

  const changedNames = changes
    .filter((c) => c.kind !== "addition")
    .map((c) => c.symbol);
  const affected = changedNames.length > 0
    ? await findAffectedFiles(filePath, changedNames)
    : [];

  return { changes, affected };
}

/**
 * True iff `filePath` is a supported CODE file that has NO committed HEAD
 * baseline to diff against. This is the single case where `detectRipple`
 * returns null for a reason worth surfacing: an edit to an uncommitted file
 * can't be ripple-analyzed (no "before" to diff), so the silence would
 * otherwise be indistinguishable from "no dependents". Lets the edit tools
 * print an honest skip-note (Honest-Response Principle) instead.
 *
 * Deliberately mirrors `detectRipple`'s own guards: it returns false for
 * non-code / json / yaml (correct silence) and false when a baseline EXISTS
 * (so the no-breaking-changes silence stays silent — that one is correct).
 */
export function rippleBaselineMissing(filePath: string): boolean {
  const lang = detectLanguage(filePath);
  if (!lang || lang === "json" || lang === "yaml") return false;
  return getGitVersion(filePath) === null;
}

function getGitVersion(filePath: string): string | null {
  return getGitVersionAt(filePath, "HEAD");
}

/** Read a file's content at a given git ref (`git show <ref>:<path>`).
 *  Returns null if the file did not exist at that ref or git fails. */
function getGitVersionAt(filePath: string, ref: string): string | null {
  try {
    const gitRoot = execSync("git rev-parse --show-toplevel", {
      cwd: dirname(filePath),
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();

    const relPath = relative(gitRoot, filePath).replace(/\\/g, "/");
    return execSync(`git show ${ref}:${relPath}`, {
      cwd: gitRoot,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    return null;
  }
}

async function getExportsFromSource(
  source: string,
  filePath: string,
  lang: string
): Promise<ExportInfo[]> {
  const { writeFileSync, unlinkSync } = await import("node:fs");
  const ext = extname(filePath);
  const tmpPath = join(tmpdir(), `ts-diff-${Date.now()}${ext}`);
  writeFileSync(tmpPath, source, "utf-8");
  try {
    return await getExports(tmpPath);
  } finally {
    try { unlinkSync(tmpPath); } catch {}
  }
}

/**
 * Normalize line endings before comparing signatures. The "before" source comes
 * from `git show` (always LF), while the "after" source is the working copy (often
 * CRLF on Windows). A multi-line signature would otherwise differ only by \r\n vs
 * \n and report a phantom "signature changed". Compare on content, not EOL style.
 */
function normSig(s: string | undefined): string | undefined {
  return s === undefined ? undefined : s.replace(/\r\n/g, "\n");
}

export function diffExports(
  before: ExportInfo[],
  after: ExportInfo[]
): StructuralChange[] {
  const changes: StructuralChange[] = [];
  const beforeMap = new Map(before.map((e) => [e.name, e]));
  const afterMap = new Map(after.map((e) => [e.name, e]));

  const deletions: ExportInfo[] = [];
  const additions: ExportInfo[] = [];

  // Pass 1: names present in both — detect kind and signature changes.
  for (const [name, bExp] of beforeMap) {
    const aExp = afterMap.get(name);
    if (!aExp) {
      deletions.push(bExp);
      continue;
    }
    if (bExp.kind !== aExp.kind) {
      changes.push({
        kind: "kind",
        symbol: name,
        detail: `"${name}" changed kind from ${bExp.kind} to ${aExp.kind}`,
      });
    }
    // Real signature change: only meaningful when both sides carry a signature
    // (callables). A signature appearing/disappearing alongside a kind change is
    // already covered by the kind change above.
    if (
      bExp.signature !== undefined &&
      aExp.signature !== undefined &&
      normSig(bExp.signature) !== normSig(aExp.signature)
    ) {
      changes.push({
        kind: "signature",
        symbol: name,
        detail: `"${name}" signature changed ${bExp.signature} -> ${aExp.signature}`,
      });
    }
  }

  for (const [name, aExp] of afterMap) {
    if (!beforeMap.has(name)) additions.push(aExp);
  }

  // Pass 2: rename detection. A deleted export and an added export of identical
  // kind + signature is almost certainly a rename rather than an unrelated
  // delete+add. Keyed on the OLD name, because dependents still reference it.
  // Only attempt this for callables (signature defined) — matching on kind alone
  // would falsely pair unrelated type/variable renames.
  const claimed = new Set<ExportInfo>();
  for (const del of deletions) {
    const match =
      del.signature !== undefined
        ? additions.find(
            (add) =>
              !claimed.has(add) &&
              add.kind === del.kind &&
              normSig(add.signature) === normSig(del.signature),
          )
        : undefined;
    if (match) {
      claimed.add(match);
      changes.push({
        kind: "rename",
        symbol: del.name,
        detail: `${del.kind} "${del.name}" renamed to "${match.name}"`,
      });
    } else {
      changes.push({
        kind: "deletion",
        symbol: del.name,
        detail: `${del.kind} "${del.name}" was removed from exports`,
      });
    }
  }

  for (const add of additions) {
    if (claimed.has(add)) continue;
    changes.push({
      kind: "addition",
      symbol: add.name,
      detail: `${add.kind} "${add.name}" added to exports`,
    });
  }

  return changes;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Does a relative import `source` written in `fromDir` resolve to `targetAbs`?
 * Mirrors Node/TS module resolution enough for the ripple gate: bare path,
 * extension-swap (".js" specifier -> ".ts" file), implicit extension, and
 * "<dir>/index.<ext>". This is what turns "mentions the symbol" into "actually
 * imports the changed module" — the precision the old git-grep gate lacked.
 */
export function importResolvesTo(
  fromDir: string,
  source: string,
  targetAbs: string,
): boolean {
  const stripExt = (p: string) =>
    p.replace(/\.(ts|tsx|js|jsx|mjs|cjs|py)$/, "");
  const base = resolve(fromDir, source);
  const target = resolve(targetAbs);
  if (base === target) return true;
  if (stripExt(base) === stripExt(target)) return true;
  const exts = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py"];
  for (const e of exts) {
    if (base + e === target) return true;
    if (resolve(base, "index" + e) === target) return true;
  }
  return false;
}

/**
 * Find the files whose code actually breaks when `symbolNames` change in
 * `filePath`. Two stages: (1) a cheap `git grep` pre-filter for files that even
 * mention a changed symbol, then (2) an AST gate — parse each candidate's
 * imports (tree-sitter `getImports`) and keep only those that genuinely import
 * the changed module. Stage 2 is the fix: a file with a coincidentally
 * same-named local no longer counts as "affected".
 *
 * Known limitation: only direct relative importers are detected. A barrel
 * (`export { x } from "./changed"`) is not an `import` node, so files importing
 * THROUGH a barrel are not followed transitively. Recorded honestly rather than
 * papered over — it trades a small recall gap for a large precision gain.
 */
async function findAffectedFiles(
  filePath: string,
  symbolNames: string[]
): Promise<AffectedFile[]> {
  const affected: AffectedFile[] = [];
  if (symbolNames.length === 0) return affected;

  let gitRoot: string;
  try {
    gitRoot = execSync("git rev-parse --show-toplevel", {
      cwd: dirname(filePath),
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    return [];
  }

  const target = resolve(filePath);

  // Stage 1: candidate files that mention any changed symbol at all.
  let candidates: string[];
  try {
    const pattern = symbolNames.map(escapeRegex).join("|");
    const grepResult = execSync(
      `git grep -lE --untracked "${pattern}" -- "*.ts" "*.tsx" "*.js" "*.jsx" "*.py"`,
      { cwd: gitRoot, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
    );
    candidates = grepResult
      .trim()
      .split("\n")
      .filter((f) => f && resolve(gitRoot, f) !== target);
  } catch {
    return [];
  }

  for (const relFile of candidates.slice(0, 40)) {
    const absFile = resolve(gitRoot, relFile);

    // Stage 2 (the AST gate): does this file actually import the changed module?
    let imports;
    try {
      imports = await getImports(absFile);
    } catch {
      continue; // unparseable — skip rather than guess
    }
    const importsChangedModule = imports.some(
      (imp) =>
        imp.source.startsWith(".") &&
        importResolvesTo(dirname(absFile), imp.source, target)
    );
    if (!importsChangedModule) continue;

    // Confirmed importer — record where it references each changed symbol.
    for (const sym of symbolNames) {
      try {
        const grepLines = execSync(`git grep -n "${escapeRegex(sym)}" -- "${relFile}"`, {
          cwd: gitRoot,
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
        });
        for (const line of grepLines.trim().split("\n")) {
          const match = line.match(/^[^:]+:(\d+):(.*)$/);
          if (match) {
            affected.push({
              file: absFile,
              line: parseInt(match[1], 10),
              usage: match[2].trim().slice(0, 120),
            });
          }
        }
      } catch {
        // sym not found in this file
      }
    }
  }

  return affected;
}
