/**
 * A/B sample emitter for the ar-tools experiments.
 *
 * Two flags shipped without a way to measure them (`AR_TOOLS_REPL`,
 * `AR_TOOLS_OUTPUT_GUARD`), which makes them an A/B in name only. This posts one sample per
 * observation to log-collector's `POST /ab`, where it becomes an ordinary event in `ns='ab'`
 * and is compared by `GET /ab?experiment=…`.
 *
 * ## Three rules this obeys, because telemetry that breaks the tool is worse than no telemetry
 *
 * 1. **Never await it.** The tool's result must not wait on a measurement. Failure to record
 *    is invisible to the caller by design.
 * 2. **Never throw.** Every error path is swallowed HERE — the only place in this package
 *    where that is correct, because the alternative is a tool call failing over a metric.
 *    `skills/program_style.md` allows a swallow when the failure is genuinely non-fatal and
 *    the reason is written down; this is that case, and this comment is the reason.
 * 3. **Never emit when the experiment is off.** `AR_TOOLS_AB=1` gates it separately from the
 *    feature flags, so the treatment arm can run without reporting, and — more usefully — the
 *    CONTROL arm can report while the feature flags are off. Without that, only the treatment
 *    would ever produce samples and there would be nothing to compare it against.
 *
 * The report deliberately carries no verdict; see `packages/log-collector/src/ab.ts` for why
 * no confidence number is computed anywhere in this path.
 */

const DEFAULT_URL = "http://localhost:3040/ab";

export function abEnabled(): boolean {
  return process.env.AR_TOOLS_AB === "1";
}

function endpoint(): string {
  return process.env.AR_TOOLS_AB_URL || DEFAULT_URL;
}

export interface AbSampleInput {
  experiment: string;
  arm: string;
  value?: number;
  tool?: string;
  outcome?: string;
  meta?: Record<string, unknown>;
}

/**
 * Post one sample. Returns immediately; the caller must not await the network.
 *
 * A 2s timeout because a hung collector must not keep a handle alive for the life of the
 * process — the sample is worth less than the socket.
 */
export function abSample(sample: AbSampleInput): void {
  if (!abEnabled()) return;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    void fetch(endpoint(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(sample),
      signal: controller.signal,
    })
      .catch(() => { /* rule 2: a lost sample must never surface as a tool failure */ })
      .finally(() => clearTimeout(timer));
  } catch {
    /* rule 2 again — including a synchronous throw from fetch being unavailable */
  }
}
