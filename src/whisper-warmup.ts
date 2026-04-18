// Standalone CLI entrypoint: provision whisper binary + model on disk,
// print a ready banner on success, exit 1 on failure. External tooling
// (Hermes daemon startup, CI preflight) invokes this via `bun run`.

import { warmupWhisperAssets } from "./whisper";

async function runCli(): Promise<void> {
  try {
    await warmupWhisperAssets({ printOutput: true });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`whisper warmup: failed - ${reason}`);
    process.exit(1);
  }
  console.log("whisper warmup: ready");
}

void runCli();
