#!/usr/bin/env bun
/**
 * One-shot evolve driver. Reads a task body from argv (joined) or stdin,
 * hands it to `evolveOnce`, prints a structured summary. Designed to be
 * invoked from a terminal or by whoever has a live handle on the user's
 * intent (e.g. the daemon when a Discord/Telegram message asks for evolve).
 *
 * Usage:
 *   bun run scripts/evolve.ts "Refactor src/foo.ts to use Y"
 *   echo "multi-line body..." | bun run scripts/evolve.ts
 *
 * Exit codes:
 *   0 — committed
 *   1 — verify failed / subagent failed (details in stderr + journal)
 *   2 — no task body provided
 */

import { applyMigrations, closeDb, openDb } from "../src/state";
import { evolveOnce, type EvolveTask } from "../src/evolve";

const body = (await readTaskBody()).trim();
if (!body) {
  process.stderr.write(
    "evolve: no task body. Pass text as args, or pipe via stdin:\n" +
      '  bun run scripts/evolve.ts "Do the thing"\n' +
      '  echo "Do the thing" | bun run scripts/evolve.ts\n'
  );
  process.exit(2);
}

const task: EvolveTask = buildTask(body);

const db = openDb();
await applyMigrations(db);

try {
  const result = await evolveOnce(db, task);
  process.stdout.write(
    `${JSON.stringify(
      {
        outcome: result.outcome,
        taskId: result.task.id,
        sha: result.sha ?? null,
        verifyOk: result.verify?.ok ?? null,
        execOk: result.exec?.ok ?? null,
      },
      null,
      2
    )}\n`
  );
  if (result.outcome !== "committed") {
    process.exit(1);
  }
} finally {
  closeDb(db);
}

function buildTask(raw: string): EvolveTask {
  const firstLine = raw.split("\n").find((l) => l.trim()) ?? "untitled";
  const title = firstLine
    .replace(/^#+\s*/, "")
    .trim()
    .slice(0, 140);
  const id = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return { id, title, body: raw };
}

async function readTaskBody(): Promise<string> {
  const argv = process.argv.slice(2).join(" ").trim();
  if (argv) return argv;
  if (process.stdin.isTTY) return "";
  let data = "";
  for await (const chunk of process.stdin) {
    data += typeof chunk === "string" ? chunk : chunk.toString();
  }
  return data;
}
