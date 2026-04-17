/**
 * Per-job cron-tick handler, extracted out of start.ts so it can be tested
 * without standing up the whole daemon.
 *
 * One-shot lifecycle contract (the subtle bit):
 *
 *   `clearJobSchedule()` is only called when a non-recurring job actually
 *   SUCCEEDED. The previous implementation ran it from `.finally()`, which
 *   swallowed failed one-shots — a crashed or non-zero job would still have
 *   its schedule stripped and could never retry. Leaving the schedule in
 *   place on failure means the next matching tick gets another chance.
 *
 *   Recurring jobs never clear their own schedule (that's the whole point
 *   of "recurring"), on either outcome.
 *
 * Forwarding preserves the original start.ts notify semantics:
 *   notify === true     → forward always
 *   notify === false    → never forward
 *   notify === "error"  → forward only when exitCode !== 0
 *
 * If the run itself threw, there is no result to forward — we surface the
 * error to the caller's `onError` instead and skip forwarding.
 */

import type { Job } from "./jobs";
import type { RunResult } from "./runner";

export interface JobTickDeps {
  resolvePrompt(prompt: string): Promise<string>;
  run(name: string, prompt: string): Promise<RunResult>;
  clearJobSchedule(name: string): Promise<void>;
  onForward?(label: string, result: RunResult): void;
  onError?(err: unknown): void;
}

export async function executeScheduledJob(job: Job, deps: JobTickDeps): Promise<void> {
  let result: RunResult;
  try {
    const prompt = await deps.resolvePrompt(job.prompt);
    result = await deps.run(job.name, prompt);
  } catch (err) {
    deps.onError?.(err);
    return;
  }

  if (deps.onForward) {
    const shouldForward =
      job.notify === true || (job.notify === "error" && result.exitCode !== 0);
    if (shouldForward) deps.onForward(job.name, result);
  }

  if (!job.recurring && result.exitCode === 0) {
    try {
      await deps.clearJobSchedule(job.name);
    } catch (err) {
      deps.onError?.(err);
    }
  }
}
