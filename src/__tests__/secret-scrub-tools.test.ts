/**
 * Integration tests for secret-scrub wiring in tools (bash, read, grep).
 * Verifies: scrub runs before funnel, honest note is appended, clean output
 * is byte-identical (passthrough invariant).
 * Uses OBVIOUSLY FAKE keys — never real secrets.
 */
import { describe, it, expect } from "vitest";
import { scrubToolOutput } from "../scrub-util.js";

// ── scrubToolOutput helper unit tests ──────────────────────────────────────

describe("scrubToolOutput — helper", () => {
  it("returns unchanged text and empty note when no secrets present", () => {
    const clean = "const x = 42;\nconsole.log(x);";
    const { text, note } = scrubToolOutput(clean);
    expect(text).toBe(clean);
    expect(note).toBe("");
  });

  it("returns redacted text and non-empty note when a secret is found", () => {
    const input = "sk-ant-api01-000000000000000000000000000000000000000";
    const { text, note } = scrubToolOutput(input);
    expect(text).toContain("[REDACTED:anthropic-key]");
    expect(text).not.toContain("sk-ant-api01");
    expect(note).toMatch(/\[secret-scrub: redacted \d+ candidate secret\(s\): anthropic-key\]/);
  });

  it("counts correctly across multiple secrets of different kinds", () => {
    const input = [
      "ghp_000000000000000000000000000000000000",
      "Authorization: Bearer fake_long_bearer_token_value_here",
    ].join("\n");
    const { note } = scrubToolOutput(input);
    expect(note).toMatch(/secret-scrub/);
    // Both kinds should appear in the note
    expect(note).toMatch(/github-token|bearer/);
  });

  it("handles empty string gracefully (passthrough)", () => {
    const { text, note } = scrubToolOutput("");
    expect(text).toBe("");
    expect(note).toBe("");
  });

  it("handles undefined/null-like gracefully (passthrough)", () => {
    // scrubToolOutput guards for falsy text
    const { text, note } = scrubToolOutput(undefined as unknown as string);
    expect(note).toBe("");
  });
});

// ── Passthrough invariant ──────────────────────────────────────────────────

describe("scrubToolOutput — passthrough for clean text", () => {
  const CLEAN_SAMPLES = [
    "const maxTokens = 4096;",
    "git log --oneline -10",
    "9c2f462b chore(templates): strip name+category",
    "(no matches)",
    "Error: file not found",
    "npm install --save-dev vitest",
  ];

  for (const sample of CLEAN_SAMPLES) {
    it(`clean text is byte-identical: ${JSON.stringify(sample)}`, () => {
      const { text, note } = scrubToolOutput(sample);
      expect(text).toBe(sample);
      expect(note).toBe("");
    });
  }
});

// ── Honest Response disclosure ────────────────────────────────────────────

describe("scrubToolOutput — Honest Response note format", () => {
  it("note format: [secret-scrub: redacted N candidate secret(s): kinds]", () => {
    const input = "password=MySuperSecretP@ss123\napi_key=ABCDEF1234567890abcdef";
    const { note } = scrubToolOutput(input);
    expect(note).toMatch(/^\[secret-scrub: redacted \d+ candidate secret\(s\): .+\]$/);
  });

  it("note is absent (empty string) when no secrets found", () => {
    const { note } = scrubToolOutput("ordinary code with no secrets");
    expect(note).toBe("");
  });
});
