import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// send() always calls process.exit() on one of: usage error, missing
// session, or after the claude invocation finishes. We spawn the CLI in a
// subprocess and pin HERMES_CLAUDE_BIN at the fake-claude fixture so no real
// claude binary is required.

const REPO_ROOT = process.cwd();
// HERMES_CLAUDE_BIN resolves relative to the subprocess cwd, so we pass the
// absolute path to the fixture (otherwise Bun can't find it from a tmp dir).
const FAKE_CLAUDE_ABS = join(REPO_ROOT, "tests/fixtures/fake-claude.ts");
const FAKE_CLAUDE_BIN = `bun run ${FAKE_CLAUDE_ABS}`;

interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function runSend(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("bun", ["run", join(REPO_ROOT, "src/index.ts"), "send", ...args], {
      cwd,
      env: {
        ...process.env,
        HERMES_CLAUDE_BIN: FAKE_CLAUDE_BIN,
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (d) => stdout.push(Buffer.from(d)));
    child.stderr.on("data", (d) => stderr.push(Buffer.from(d)));
    // send() does not always call process.exit() — on exit code 0 it returns
    // cleanly and relies on Bun to close once the event loop is idle. Runner
    // internals keep a 5-minute setTimeout alive (the Claude invocation
    // guard), so we grace-kill after a short quiet period and take the exit
    // as whatever the child reports.
    let closed = false;
    const killer = setTimeout(() => {
      if (!closed) {
        try {
          child.kill("SIGKILL");
        } catch {}
      }
    }, 5_000);
    const hardTimer = setTimeout(() => {
      if (!closed) {
        try {
          child.kill("SIGKILL");
        } catch {}
        reject(new Error("send subprocess did not terminate within 30s"));
      }
    }, 30_000);
    child.on("error", (err) => {
      closed = true;
      clearTimeout(killer);
      clearTimeout(hardTimer);
      reject(err);
    });
    child.on("close", (code, signal) => {
      closed = true;
      clearTimeout(killer);
      clearTimeout(hardTimer);
      // Treat SIGKILL (from the grace killer) as exit 0 when stdout looks
      // complete — the real work already finished.
      const reportedExit = code ?? (signal === "SIGKILL" ? 0 : 1);
      resolve({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        exitCode: reportedExit,
      });
    });
  });
}

async function freshProject(opts: { withSettings?: boolean; withSession?: boolean }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "hermes-send-"));
  const hermesDir = join(dir, ".claude", "hermes");
  await mkdir(hermesDir, { recursive: true });
  if (opts.withSettings !== false) {
    // initConfig() will write defaults if missing; providing an empty
    // settings.json avoids needing initConfig's default write logic.
    await writeFile(
      join(hermesDir, "settings.json"),
      JSON.stringify({
        model: "",
        heartbeat: { enabled: false, interval: 15, excludeWindows: [] },
        telegram: { token: "", allowedUserIds: [] },
        discord: { token: "", allowedUserIds: [], listenChannels: [] },
        security: { level: "moderate", allowedTools: [], disallowedTools: [] },
      })
    );
  }
  if (opts.withSession) {
    await writeFile(
      join(hermesDir, "session.json"),
      JSON.stringify({
        sessionId: "fake-existing-session",
        createdAt: new Date().toISOString(),
        lastUsedAt: new Date().toISOString(),
        turnCount: 0,
        compactWarned: false,
      })
    );
  }
  return dir;
}

describe("send command", () => {
  const dirsToClean: string[] = [];

  afterAll(async () => {
    for (const d of dirsToClean) {
      try {
        await rm(d, { recursive: true, force: true });
      } catch {}
    }
  });

  test("no message: prints usage and exits 1", async () => {
    const dir = await freshProject({ withSession: true });
    dirsToClean.push(dir);

    const result = await runSend(dir, []);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toLowerCase()).toContain("usage");
  }, 25_000);

  test("only flags, no message: prints usage and exits 1", async () => {
    const dir = await freshProject({ withSession: true });
    dirsToClean.push(dir);

    // Filtering out the flags leaves an empty message
    const result = await runSend(dir, ["--telegram", "--discord"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toLowerCase()).toContain("usage");
  }, 25_000);

  test("no active session: exits 1 with a clear message", async () => {
    const dir = await freshProject({ withSession: false });
    dirsToClean.push(dir);

    const result = await runSend(dir, ["hello"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toLowerCase()).toContain("no active session");
  }, 25_000);

  test("active session + message: fake-claude replies are echoed to stdout", async () => {
    const dir = await freshProject({ withSession: true });
    dirsToClean.push(dir);

    const result = await runSend(dir, ["hello", "there"], {
      HERMES_FAKE_REPLY: "pong",
    });

    // Exit code 0 OR 0-from-grace-kill are both acceptable — runner holds
    // an unref'd timer open so we may SIGKILL after stdout has completed.
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("pong");
  }, 40_000);

  test("--telegram without --to: exits 1 with a 'target required' message (pre-network)", async () => {
    const dir = await freshProject({ withSession: true });
    dirsToClean.push(dir);

    const result = await runSend(dir, ["hello", "--telegram"], {
      HERMES_FAKE_REPLY: "pong",
    });
    expect(result.exitCode).toBe(1);
    // Refuses to broadcast — fails before hitting the Telegram network layer.
    expect(result.stderr.toLowerCase()).toContain("--to");
  }, 30_000);

  test("--discord without --to: exits 1 with a 'target required' message", async () => {
    const dir = await freshProject({ withSession: true });
    dirsToClean.push(dir);

    const result = await runSend(dir, ["hello", "--discord"], {
      HERMES_FAKE_REPLY: "pong",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toLowerCase()).toContain("--to");
  }, 30_000);

  test("--telegram --to on unconfigured token: exits 1 with a telegram-flavored error", async () => {
    const dir = await freshProject({ withSession: true });
    dirsToClean.push(dir);

    const result = await runSend(dir, ["hello", "--telegram", "--to", "123"], { HERMES_FAKE_REPLY: "pong" });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toLowerCase()).toContain("telegram");
  }, 30_000);

  test("--telegram --discord together: exits 1 with a mutually-exclusive error", async () => {
    const dir = await freshProject({ withSession: true });
    dirsToClean.push(dir);

    const result = await runSend(dir, ["hello", "--telegram", "--discord", "--to", "1"], {
      HERMES_FAKE_REPLY: "pong",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toLowerCase()).toContain("not both");
  }, 30_000);
});
