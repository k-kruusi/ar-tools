import { scrubSecrets } from "@agentruntime/secret-scrub";

export interface ScrubOutput {
  /** Text with secrets replaced by [REDACTED:<kind>] tokens. */
  text: string;
  /**
   * One-line Honest Response disclosure to append to tool output when non-empty.
   * Format: "[secret-scrub: redacted N candidate secret(s): kind1, kind2]"
   * Empty string when no secrets were found (passthrough).
   */
  note: string;
}

/**
 * Scrub secrets from a single text block and produce a disclosure note.
 * Called BEFORE token-funnel compression so funnel sees the sanitised text.
 */
export function scrubToolOutput(text: string): ScrubOutput {
  if (!text) return { text, note: "" };
  const { text: scrubbed, hits } = scrubSecrets(text);
  if (hits.length === 0) return { text, note: "" };
  const total = hits.reduce((sum, h) => sum + h.count, 0);
  const kinds = hits.map((h) => h.kind).join(", ");
  return {
    text: scrubbed,
    note: `[secret-scrub: redacted ${total} candidate secret(s): ${kinds}]`,
  };
}
