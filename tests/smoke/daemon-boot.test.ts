import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = process.cwd();
const FAKE_CLAUDE = join(REPO_ROOT, "tests", "fixtures", "fake-claude.ts");
const ENTRY = join(REPO_ROOT, "src", "index.ts");

interface BootResult {
  child: ChildProcess;
  cwd: string;
  stdout: string;
  stderr: string;
}

async function bootDaemon(timeoutMs = 20_000, extraArgs: string[] = []): Promise<BootResult> {
  const cwd = await mkdtemp(join(tmpdir(), "hermes-daemon-boot-"));
  await mkdir(join(cwd, ".claude", "hermes"), { recursive: true });

  const child = spawn("bun", ["run", ENTRY, "start", ...extraArgs], {
    cwd,
    env: {
      ...process.env,
      HERMES_CLAUDE_BIN: `bun run ${FAKE_CLAUDE}`,
      HERMES_SKIP_PREFLIGHT: "1",
      HERMES_FAKE_SESSION_ID: "boot-test-session",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (d) => {
    stdout += d.toString("utf8");
  });
  child.stderr?.on("data", (d) => {
    stderr += d.toString("utf8");
  });

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (stdout.includes("Bootstrap complete") || stdout.includes("Plugin preflight skipped")) {
      // Boot reached the post-bootstrap point. Give the cron-tick interval a
      // brief moment so the state file write is observable.
      await Bun.sleep(150);
      return { child, cwd, stdout, stderr };
    }
    if (child.exitCode !== null) break;
    await Bun.sleep(50);
  }

  child.kill("SIGKILL");
  throw new Error(
    `Daemon failed to reach "Bootstrap complete" within ${timeoutMs}ms.\nstdout=\n${stdout}\nstderr=\n${stderr}`
  );
}

async function killDaemon(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline && child.exitCode === null) {
    await Bun.sleep(50);
  }
  if (child.exitCode === null) child.kill("SIGKILL");
}

describe("daemon-boot smoke", () => {
  const cleanups: string[] = [];

  afterAll(async () => {
    for (const dir of cleanups) {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  test("boots, writes pidfile, advertises status, then exits on signal", async () => {
    const { child, cwd, stdout } = await bootDaemon();
    cleanups.push(cwd);

    expect(stdout).toContain("Claude Hermes daemon started");
    expect(stdout).toContain("Bootstrap complete");

    const pidPath = join(cwd, ".claude", "hermes", "daemon.pid");
    expect(existsSync(pidPath)).toBe(true);
    const pid = Number((await readFile(pidPath, "utf8")).trim());
    expect(pid).toBeGreaterThan(0);
    expect(pid).toBe(child.pid as number);

    await killDaemon(child);
  }, 30_000);

  test("respects HERMES_SKIP_PREFLIGHT (no plugin install spawned)", async () => {
    const { child, cwd, stdout } = await bootDaemon();
    cleanups.push(cwd);

    expect(stdout).toContain("Plugin preflight skipped");
    expect(stdout).not.toContain("Plugin preflight started in background");

    await killDaemon(child);
  }, 30_000);

  test("refuses to start a second daemon in the same directory", async () => {
    const { child: first, cwd } = await bootDaemon();
    cleanups.push(cwd);

    // Spawn second instance in the SAME cwd — should refuse.
    const second = spawn("bun", ["run", ENTRY, "start"], {
      cwd,
      env: {
        ...process.env,
        HERMES_CLAUDE_BIN: `bun run ${FAKE_CLAUDE}`,
        HERMES_SKIP_PREFLIGHT: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let secondStderr = "";
    second.stderr?.on("data", (d) => {
      secondStderr += d.toString("utf8");
    });

    const exitCode: number = await new Promise((resolve) => {
      second.on("close", (code) => resolve(code ?? 1));
      setTimeout(() => {
        second.kill("SIGKILL");
        resolve(124);
      }, 8_000);
    });

    expect(exitCode).not.toBe(0);
    expect(secondStderr.toLowerCase()).toContain("already running");

    await killDaemon(first);
  }, 45_000);
});
