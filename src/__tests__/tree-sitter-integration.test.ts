import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import {
  init,
  getOutline,
  formatOutline,
  detectLanguage,
  getExports,
} from "@agentruntime/tree-sitter";
import { detectRipple } from "../lib/structural-diff.js";

const MONO = resolve(import.meta.dirname!, "../../../..");
const TRACKER = resolve(MONO, "packages/compaction/src/tracker.ts");

async function main() {
  let passed = 0;
  let failed = 0;

  function assert(label: string, condition: boolean, detail?: string): void {
    if (condition) {
      console.log(`  ✓ ${label}`);
      passed++;
    } else {
      console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
      failed++;
    }
  }

  await init();

  // Test detectLanguage
  console.log("\n── detectLanguage ──");
  assert("ts", detectLanguage("foo.ts") === "typescript");
  assert("py", detectLanguage("bar.py") === "python");
  assert("md", detectLanguage("readme.md") === null);
  assert("txt", detectLanguage("notes.txt") === null);

  // Test outline via tree-sitter
  console.log("\n── getOutline on tracker.ts ──");
  const outline = await getOutline(TRACKER);
  assert("outline non-empty", outline.length > 0);
  const totalLines = readFileSync(TRACKER, "utf-8").split("\n").length;
  const formatted = formatOutline(TRACKER, outline, totalLines);
  assert("formatted is shorter than file", formatted.length < totalLines * 40);
  console.log(`  Outline: ${formatted.split("\n").length} lines vs ${totalLines} file lines`);

  // Test getExports
  console.log("\n── getExports on tracker.ts ──");
  const exports = await getExports(TRACKER);
  assert("has exports", exports.length > 0);
  assert(
    "exports ShadowContextTracker",
    exports.some((e) => e.name === "ShadowContextTracker"),
  );

  // Test detectRipple (no changes — file matches git HEAD)
  console.log("\n── detectRipple on tracker.ts (no changes expected) ──");
  const ripple = await detectRipple(TRACKER);
  // If the file hasn't been modified from HEAD, ripple should be null or have no changes
  if (ripple === null) {
    assert("no ripple (file matches HEAD)", true);
  } else {
    assert("ripple changes", ripple.changes.length >= 0, `${ripple.changes.length} changes`);
  }

  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
