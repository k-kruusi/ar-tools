// Fuzzy "replacer cascade" for edit_file — ported from opencode's edit tool
// (https://github.com/sst/opencode, packages/opencode/src/tool/edit.ts), adapted
// to our code style and trimmed to the strategies we need.
//
// The problem: an exact-match find-and-replace fails the moment the supplied
// old_text drifts by a space of indentation or a trailing space — the single
// most common edit failure. Each Replacer below yields candidate substrings that
// exist *verbatim* in `content` but were located by a progressively looser match
// against `find`. `replace()` walks them in order, refusing oversize matches and
// requiring uniqueness, so a loose locator never silently rewrites the wrong span.

/**
 * A Replacer locates `find` inside `content` under some matching relaxation and
 * yields the real, verbatim substring(s) of `content` that it matched. Every
 * yielded string MUST satisfy `content.includes(yielded)` — the caller relies on
 * that to do the actual textual replacement.
 */
export type Replacer = (content: string, find: string) => Generator<string>;

// Similarity threshold for the block-anchor fallback (Levenshtein on middle lines).
const SIMILARITY_THRESHOLD = 0.65;

/** Levenshtein edit distance between two strings. */
function levenshtein(a: string, b: string): number {
  if (a === "" || b === "") return Math.max(a.length, b.length);
  const matrix = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(matrix[i - 1][j] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j - 1] + cost);
    }
  }
  return matrix[a.length][b.length];
}

/** Exact match — yields find unchanged. */
export const SimpleReplacer: Replacer = function* (_content, find) {
  yield find;
};

/**
 * Per-line trimmed match. Finds a run of lines where each line equals the
 * corresponding find line after `.trim()` (absorbs leading/trailing-whitespace
 * and indentation drift), and yields the real content substring spanning them.
 */
export const LineTrimmedReplacer: Replacer = function* (content, find) {
  const originalLines = content.split("\n");
  const searchLines = find.split("\n");
  if (searchLines[searchLines.length - 1] === "") searchLines.pop();
  if (searchLines.length === 0) return;

  for (let i = 0; i <= originalLines.length - searchLines.length; i++) {
    let matches = true;
    for (let j = 0; j < searchLines.length; j++) {
      if (originalLines[i + j].trim() !== searchLines[j].trim()) {
        matches = false;
        break;
      }
    }
    if (!matches) continue;

    let matchStartIndex = 0;
    for (let k = 0; k < i; k++) matchStartIndex += originalLines[k].length + 1;

    let matchEndIndex = matchStartIndex;
    for (let k = 0; k < searchLines.length; k++) {
      matchEndIndex += originalLines[i + k].length;
      if (k < searchLines.length - 1) matchEndIndex += 1; // newline between lines
    }
    yield content.substring(matchStartIndex, matchEndIndex);
  }
};

/**
 * Block-anchor match (find must be >= 3 lines). Anchors on the first and last
 * trimmed lines; among candidate blocks of similar size, picks the one whose
 * middle lines are closest by Levenshtein similarity, accepting only above
 * threshold. Tolerant of heavily-reformatted interiors as long as the anchors
 * and the overall shape line up.
 */
export const BlockAnchorReplacer: Replacer = function* (content, find) {
  const originalLines = content.split("\n");
  const searchLines = find.split("\n");
  if (searchLines.length < 3) return;
  if (searchLines[searchLines.length - 1] === "") searchLines.pop();
  if (searchLines.length < 3) return;

  const firstLineSearch = searchLines[0].trim();
  const lastLineSearch = searchLines[searchLines.length - 1].trim();
  const searchBlockSize = searchLines.length;
  const maxLineDelta = Math.max(1, Math.floor(searchBlockSize * 0.25));

  const candidates: Array<{ startLine: number; endLine: number }> = [];
  for (let i = 0; i < originalLines.length; i++) {
    if (originalLines[i].trim() !== firstLineSearch) continue;
    for (let j = i + 2; j < originalLines.length; j++) {
      if (originalLines[j].trim() === lastLineSearch) {
        const actualBlockSize = j - i + 1;
        if (Math.abs(actualBlockSize - searchBlockSize) <= maxLineDelta) {
          candidates.push({ startLine: i, endLine: j });
        }
        break; // only the first matching last-line for this start
      }
    }
  }
  if (candidates.length === 0) return;

  const spanOf = (startLine: number, endLine: number): string => {
    let matchStartIndex = 0;
    for (let k = 0; k < startLine; k++) matchStartIndex += originalLines[k].length + 1;
    let matchEndIndex = matchStartIndex;
    for (let k = startLine; k <= endLine; k++) {
      matchEndIndex += originalLines[k].length;
      if (k < endLine) matchEndIndex += 1;
    }
    return content.substring(matchStartIndex, matchEndIndex);
  };

  const middleSimilarity = (startLine: number, endLine: number): number => {
    const actualBlockSize = endLine - startLine + 1;
    const linesToCheck = Math.min(searchBlockSize - 2, actualBlockSize - 2);
    if (linesToCheck <= 0) return 1.0; // no middle lines — trust the anchors
    let similarity = 0;
    for (let j = 1; j < searchBlockSize - 1 && j < actualBlockSize - 1; j++) {
      const originalLine = originalLines[startLine + j].trim();
      const searchLine = searchLines[j].trim();
      const maxLen = Math.max(originalLine.length, searchLine.length);
      if (maxLen === 0) continue;
      similarity += (1 - levenshtein(originalLine, searchLine) / maxLen) / linesToCheck;
    }
    return similarity;
  };

  let bestMatch: { startLine: number; endLine: number } | null = null;
  let maxSimilarity = -1;
  for (const candidate of candidates) {
    const sim = middleSimilarity(candidate.startLine, candidate.endLine);
    if (sim > maxSimilarity) {
      maxSimilarity = sim;
      bestMatch = candidate;
    }
  }
  if (bestMatch && maxSimilarity >= SIMILARITY_THRESHOLD) {
    yield spanOf(bestMatch.startLine, bestMatch.endLine);
  }
};

/**
 * Whitespace-normalized match. Collapses runs of whitespace to a single space;
 * a content line/block whose normalized form equals the normalized find is
 * matched, and the real (un-normalized) span is yielded. Handles drift like
 * tabs-vs-spaces or doubled spaces inside a line.
 */
export const WhitespaceNormalizedReplacer: Replacer = function* (content, find) {
  const normalize = (text: string) => text.replace(/\s+/g, " ").trim();
  const normalizedFind = normalize(find);
  if (normalizedFind === "") return;

  const lines = content.split("\n");

  // Single-line: whole-line match, then substring-within-line match.
  for (const line of lines) {
    if (normalize(line) === normalizedFind) {
      yield line;
    } else if (normalize(line).includes(normalizedFind)) {
      const words = find.trim().split(/\s+/);
      if (words.length > 0) {
        const pattern = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+");
        try {
          const match = line.match(new RegExp(pattern));
          if (match) yield match[0];
        } catch {
          // invalid regex — skip
        }
      }
    }
  }

  // Multi-line block match.
  const findLines = find.split("\n");
  if (findLines.length > 1) {
    for (let i = 0; i <= lines.length - findLines.length; i++) {
      const block = lines.slice(i, i + findLines.length).join("\n");
      if (normalize(block) === normalizedFind) yield block;
    }
  }
};

/**
 * True when `search` (a located candidate span) is grossly larger than the
 * supplied `oldString` — a signal the loose match latched onto far more text
 * than intended, so the replacement should be refused rather than guessed.
 */
export function isDisproportionateMatch(search: string, oldString: string): boolean {
  const oldLines = oldString.split("\n").length;
  const searchLines = search.split("\n").length;
  if (searchLines >= Math.max(oldLines + 3, oldLines * 2)) return true;
  if (oldLines === 1) return false;
  return search.trim().length > Math.max(oldString.trim().length + 500, oldString.trim().length * 4);
}

interface NearMatchHint {
  startLine: number; // 1-based, first line of the best-matching window
  endLine: number; // 1-based, last line of the best-matching window
  overlap: number; // 0..1, fraction of old_text lines found in the window
  preview: string; // numbered context lines around the match
}

/** Format numbered lines matching read_file's ` NNNNNN │ text` convention. */
function formatContextLines(allLines: string[], startLine: number, endLine: number, radius: number): string {
  const from = Math.max(1, startLine - radius);
  const to = Math.min(allLines.length, endLine + radius);
  return allLines
    .slice(from - 1, to)
    .map((line, i) => `${String(from + i).padStart(6)} │ ${line}`)
    .join("\n");
}

/**
 * Sliding-window near-match search over file content, run ONLY on the failure
 * path after all four replacer strategies miss. Compares old_text as a BLOCK
 * (not per-line) against windows of similar size in the file. Scores by the
 * fraction of old_text's non-empty trimmed lines that appear (trimmed) in the
 * window — a coarse "line overlap ratio" that catches the common case (same
 * lines, different whitespace/order) without importing a new dependency or
 * running per-line Levenshtein (which misses multi-line drift).
 *
 * Returns null when nothing scores above threshold, or on very large files
 * (>20k lines) where the scan cost isn't justified for a diagnostic hint.
 */
function findNearMatch(content: string, oldString: string): NearMatchHint | null {
  const contentLines = content.split("\n");
  if (contentLines.length > 20_000) return null;

  const oldLines = oldString.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  if (oldLines.length === 0) return null;

  const windowSize = Math.max(oldLines.length, 3);
  if (windowSize > contentLines.length) return null;

  let best: { startLine: number; endLine: number; overlap: number } | null = null;

  for (let i = 0; i <= contentLines.length - windowSize; i++) {
    const window = contentLines.slice(i, i + windowSize);
    const windowTrimmed = new Set(window.map((l) => l.trim()));
    let hits = 0;
    for (const ol of oldLines) {
      if (windowTrimmed.has(ol)) hits++;
    }
    const overlap = hits / oldLines.length;
    if (overlap >= 0.4 && overlap < 1.0 && overlap > (best?.overlap ?? 0)) {
      best = { startLine: i + 1, endLine: i + windowSize, overlap };
    }
  }

  if (!best) return null;
  return {
    ...best,
    preview: formatContextLines(contentLines, best.startLine, best.endLine, 2),
  };
}

/** 1-based line numbers of every occurrence of `needle` in `content`. */
function lineNumbersOf(content: string, needle: string): number[] {
  const result: number[] = [];
  let idx = content.indexOf(needle);
  while (idx !== -1) {
    result.push(content.slice(0, idx).split("\n").length);
    idx = content.indexOf(needle, idx + 1);
  }
  return result;
}

export interface ReplaceResult {
  /** The new content with the replacement applied. */
  content: string;
  /** Name of the replacer strategy that matched (e.g. "exact", "line-trimmed"). */
  strategy: string;
  /** Number of occurrences replaced (1 unless replaceAll matched several). */
  count: number;
}

const REPLACERS: Array<[string, Replacer]> = [
  ["exact", SimpleReplacer],
  ["line-trimmed", LineTrimmedReplacer],
  ["block-anchor", BlockAnchorReplacer],
  ["whitespace-normalized", WhitespaceNormalizedReplacer],
];

/**
 * Try each replacer in order. For the first candidate span that exists in
 * `content`:
 *  - if the span is disproportionately larger than oldString → throw (refuse).
 *  - if replaceAll → replace every occurrence of that span.
 *  - else require the span to be unique; if not, keep looking; if unique, replace it.
 *
 * Throws a clear, actionable error when nothing matches or when matches are
 * never unique. Returns the matching strategy alongside the new content.
 */
export function replaceWithStrategy(
  content: string,
  oldString: string,
  newString: string,
  replaceAll = false,
): ReplaceResult {
  let notFound = true;

  for (const [strategy, replacer] of REPLACERS) {
    for (const search of replacer(content, oldString)) {
      const index = content.indexOf(search);
      if (index === -1) continue; // defensive: replacer yielded a non-verbatim span
      notFound = false;

      if (isDisproportionateMatch(search, oldString)) {
        throw new Error(
          "Refusing replacement: the matched span is much larger than old_text (oversize match). " +
            "Re-read the file and provide the exact text — including whitespace and indentation — for the intended replacement.",
        );
      }

      if (replaceAll) {
        const count = content.split(search).length - 1;
        return { content: content.replaceAll(search, newString), strategy, count };
      }

      const lastIndex = content.lastIndexOf(search);
      if (index !== lastIndex) continue; // not unique under this candidate — try the next

      return {
        content: content.substring(0, index) + newString + content.substring(index + search.length),
        strategy,
        count: 1,
      };
    }
  }

  if (notFound) {
    const near = findNearMatch(content, oldString);
    if (near) {
      throw new Error(
        `old_text not found verbatim, but similar content exists at lines ${near.startLine}-${near.endLine} ` +
          `(${Math.round(near.overlap * 100)}% line overlap) — likely whitespace/indentation drift or a stale read:\n\n` +
          `${near.preview}\n\n` +
          `Re-read the file and copy old_text exactly, or use edit_range with the line numbers above.`,
      );
    }
    throw new Error(
      "old_text not found anywhere in the file, even with fuzzy matching — check that file_path is correct (wrong file?) or re-read it before retrying (stale content?).",
    );
  }

  const matchLines = lineNumbersOf(content, oldString);
  const uniqueLines = [...new Set(matchLines)];
  throw new Error(
    matchLines.length > 0
      ? `old_text matches at ${matchLines.length} locations (line${uniqueLines.length > 1 ? "s" : ""} ${uniqueLines.slice(0, 10).join(", ")}${uniqueLines.length > 10 ? ", ..." : ""}) — not unique. ` +
        `Add more surrounding context to old_text to disambiguate, or set replace_all: true to replace all ${matchLines.length}.`
      : `old_text appears multiple times in the file (via fuzzy matching). Add more surrounding context to make the match unique, or set replace_all: true.`,
  );
}

/** Convenience wrapper returning only the new content (parity with opencode's `replace`). */
export function replace(content: string, oldString: string, newString: string, replaceAll = false): string {
  return replaceWithStrategy(content, oldString, newString, replaceAll).content;
}
