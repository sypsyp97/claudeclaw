import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// stop() calls `process.exit(0)` on every path, so we spawn the CLI in a
// subprocess and inspect stdout/exit code. The tests drive the three
// documented code paths:
//
//   1. no pid file           -> "No daemon is running", exit 0
//   2. pid file, dead pid    -> "already dead", exit 0
//   3. pid file, live pid    -> "Stopped daemon (PID X)", pid file gone,
//                               sacrificial child gets SIGTERM and exits.

const REPO_ROOT = process.cwd();

interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function runStop(cwd: string): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("bun", ["run", join(REPO_ROOT, "src/index.ts"), "--stop"], {
      cwd,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (d) => stdout.push(Buffer.from(d)));
    child.stderr.on("data", (d) => stderr.push(Buffer.from(d)));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("stop subprocess timed out after 15s"));
    }, 15_000);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        exitCode: code ?? 1,
      });
    });
  });
}

function spawnSacrificialDaemon(): Promise<{ pid: number; child: ReturnType<typeof spawn> }> {
  // A tiny bun process that does nothing for 60s. We write its pid into the
  // pid file and expect stop() to SIGTERM it.
  return new Promise((resolve, reject) => {
    const child = spawn(
      "bun",
      ["-e", "setTimeout(() => process.exit(0), 60000); process.stdout.write('ready\\n');"],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
      }
    );
    let settled = false;
    const onReady = (buf: Buffer) => {
      if (buf.toString().includes("ready") && !settled) {
        settled = true;
        if (!child.pid) {
          reject(new Error("sacrificial daemon has no pid"));
          return;
        }
        resolve({ pid: child.pid, child });
      }
    };
    child.stdout?.on("data", onReady);
    child.on("error", (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
    setTimeout(() => {
      if (!settled) {
        settled = true;
        if (child.pid) {
          resolve({ pid: child.pid, child });
        } else {
          reject(new Error("sacrificial daemon never started"));
        }
      }
    }, 2_000);
  });
}

describe("stop command", () => {
  let tempDir: string;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "hermes-stop-"));
    await mkdir(join(tempDir, ".claude", "hermes"), { recursive: true });
  });

  afterAll(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("with no pid file: reports gracefully and exits 0", async () => {
    const result = await runStop(tempDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toLowerCase()).toContain("no daemon");
  }, 20_000);

  test("with stale pid file (dead process): cleans up and exits 0", async () => {
    const pidFile = join(tempDir, ".claude", "hermes", "daemon.pid");
    // 999999999 is extremely unlikely to be a live pid. The kernel returns
    // ESRCH; stop() catches it and logs "already dead".
    await writeFile(pidFile, "999999999\n");

    const result = await runStop(tempDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toLowerCase()).toMatch(/already dead|no daemon/);

    // pid file should be gone after cleanup
    const stillThere = await Bun.file(pidFile)
      .text()
      .then(() => true)
      .catch(() => false);
    expect(stillThere).toBe(false);
  }, 20_000);

  test("with live pid file: SIGTERMs the process and removes pid file", async () => {
    const { pid, child } = await spawnSacrificialDaemon();
    try {
      const pidFile = join(tempDir, ".claude", "hermes", "daemon.pid");
      await writeFile(pidFile, `${pid}\n`);

      const result = await runStop(tempDir);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(String(pid));
      expect(result.stdout.toLowerCase()).toContain("stopped");

      // pid file should be removed
      const stillThere = await Bun.file(pidFile)
        .text()
        .then(() => true)
        .catch(() => false);
      expect(stillThere).toBe(false);

      // Wait briefly for the sacrificial process to exit
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null) return resolve();
        const t = setTimeout(resolve, 2_000);
        child.on("exit", () => {
          clearTimeout(t);
          resolve();
        });
      });
    } finally {
      if (child.exitCode === null) {
        try {
          child.kill("SIGKILL");
        } catch {}
      }
    }
  }, 25_000);

  // ---------------------------------------------------------------------
  // Bug 1 regression: stop.ts captures process.cwd() at module load.
  //
  // `src/commands/stop.ts:7-10` freezes CLAUDE_DIR / STATUSLINE_FILE /
  // CLAUDE_SETTINGS_FILE / HEARTBEAT_DIR at import time. src/paths.ts has
  // a banner explicitly warning against this pattern. If a caller imports
  // stop.ts from cwd=A and then chdirs to cwd=B before calling stop(),
  // the teardown must operate on files under B/.claude, NOT under A/.claude.
  //
  // We can't call stop() in-process (it ends with process.exit(0)), so we
  // drive it through a tiny Bun driver that imports stop.ts, chdirs, and
  // invokes it. Then we inspect the two workspaces' filesystems.
  // ---------------------------------------------------------------------
  test("Bug 1: stop() resolves paths at call time, not at import time", async () => {
    const root = REPO_ROOT;
    // Two independent workspaces, each with a fake .claude tree that stop()
    // should only touch when it is the process's current cwd.
    const cwdA = await mkdtemp(join(tmpdir(), "hermes-stop-bug1-A-"));
    const cwdB = await mkdtemp(join(tmpdir(), "hermes-stop-bug1-B-"));
    try {
      for (const d of [cwdA, cwdB]) {
        await mkdir(join(d, ".claude", "hermes"), { recursive: true });
        // No pid file -> stop() would bail early without touching anything.
        // Give both dirs a fake daemon.pid pointing at a long-dead pid so
        // stop() proceeds through the full teardown path.
        await writeFile(join(d, ".claude", "hermes", "daemon.pid"), "999999999\n");
        await writeFile(join(d, ".claude", "hermes", "state.json"), JSON.stringify({ ok: true }));
        await writeFile(join(d, ".claude", "statusline.cjs"), "// placeholder statusline\n");
        await writeFile(
          join(d, ".claude", "settings.json"),
          JSON.stringify(
            { statusLine: { type: "command", command: "node .claude/statusline.cjs" } },
            null,
            2
          ) + "\n"
        );
      }

      // Driver script: import stop.ts WHILE cwd=A, then chdir to B, then
      // invoke stop(). Correct behaviour is that B's files get removed
      // and A's stay untouched. Buggy behaviour freezes paths at import
      // time from A and tears down A/ files instead.
      const driver = join(cwdA, "driver.ts");
      const stopAbs = join(root, "src", "commands", "stop.ts").replace(/\\/g, "/");
      const cwdBPosix = cwdB.replace(/\\/g, "/");
      const driverCode = [
        `// Driver runs with cwd=${cwdA.replace(/\\/g, "/")}`,
        `import { stop } from ${JSON.stringify(stopAbs)};`,
        `process.chdir(${JSON.stringify(cwdBPosix)});`,
        `await stop();`,
      ].join("\n");
      await writeFile(driver, driverCode);

      const exit = await new Promise<number>((resolve, reject) => {
        const p = spawn("bun", ["run", driver], {
          cwd: cwdA,
          env: { ...process.env },
          stdio: ["ignore", "pipe", "pipe"],
        });
        const killTimer = setTimeout(() => {
          p.kill("SIGKILL");
          reject(new Error("stop driver timed out"));
        }, 15_000);
        p.on("error", (err) => {
          clearTimeout(killTimer);
          reject(err);
        });
        p.on("close", (code) => {
          clearTimeout(killTimer);
          resolve(code ?? 1);
        });
      });
      expect(exit).toBe(0);

      // After stop() returns, cwd=B files should be gone; cwd=A files
      // should be intact (the process was never pointed at A after chdir).
      const exists = async (p: string) => await Bun.file(p).exists();

      // cwd=B: teardown must have happened here.
      expect(await exists(join(cwdB, ".claude", "hermes", "daemon.pid"))).toBe(false);
      expect(await exists(join(cwdB, ".claude", "hermes", "state.json"))).toBe(false);
      expect(await exists(join(cwdB, ".claude", "statusline.cjs"))).toBe(false);
      // settings.json is kept, but its statusLine key must be removed.
      const settingsB = JSON.parse(await Bun.file(join(cwdB, ".claude", "settings.json")).text());
      expect(settingsB.statusLine).toBeUndefined();

      // cwd=A: nothing in .claude/ should have been touched.
      expect(await exists(join(cwdA, ".claude", "hermes", "state.json"))).toBe(true);
      expect(await exists(join(cwdA, ".claude", "statusline.cjs"))).toBe(true);
      const settingsA = JSON.parse(await Bun.file(join(cwdA, ".claude", "settings.json")).text());
      expect(settingsA.statusLine).toBeDefined();
    } finally {
      await rm(cwdA, { recursive: true, force: true }).catch(() => {});
      await rm(cwdB, { recursive: true, force: true }).catch(() => {});
    }
  }, 30_000);

  // ---------------------------------------------------------------------
  // PL-1: stopAll() self-destructs when invoked from inside a
  // hermes-spawned Claude child.
  //
  // If a skill running in a daemon's Claude child calls `--stop-all`,
  // the current implementation SIGTERMs every row in the registry —
  // including the daemon that is awaiting the skill's reply.
  //
  // Agreed fix: the daemon sets HERMES_PARENT_PID=<daemon-pid> in the
  // env of any child it spawns. stopAll() reads
  // process.env.HERMES_PARENT_PID and skips that pid, leaving its
  // pid-file and registry row alone.
  // ---------------------------------------------------------------------
  test("PL-1: stopAll() skips the parent daemon pid from HERMES_PARENT_PID", async () => {
    // Two dummy daemons: dummy-1 impersonates the *parent* daemon (the
    // one whose Claude child is invoking --stop-all). dummy-2 is any
    // other daemon in the registry — stopAll should happily SIGTERM it.
    const pidsToKill: number[] = [];
    const dirsToClean: string[] = [];

    const spawnDummy = (): Promise<number> => {
      return new Promise((resolve, reject) => {
        const p = spawn(
          "node",
          [
            "-e",
            "process.on('SIGTERM',()=>process.exit(0));process.stdout.write('ready\\n');setInterval(()=>{},1<<30)",
          ],
          { stdio: ["ignore", "pipe", "ignore"] }
        );
        let settled = false;
        const finish = (err?: Error) => {
          if (settled) return;
          settled = true;
          if (err) reject(err);
          else if (p.pid) resolve(p.pid);
          else reject(new Error("dummy daemon has no pid"));
        };
        p.stdout?.on("data", (buf: Buffer) => {
          if (buf.toString().includes("ready")) finish();
        });
        p.on("error", (err) => finish(err));
        setTimeout(() => finish(), 2_000);
      });
    };

    const dummy1 = await spawnDummy();
    pidsToKill.push(dummy1);
    const dummy2 = await spawnDummy();
    pidsToKill.push(dummy2);

    const regDir = await mkdtemp(join(tmpdir(), "hermes-stopall-pl1-reg-"));
    dirsToClean.push(regDir);
    const registryPath = join(regDir, "daemons.json");

    // Workspaces for each dummy — stopAll tries to unlink pid files
    // under entry.cwd/.claude/hermes/daemon.pid.
    const cwd1 = await mkdtemp(join(tmpdir(), "hermes-stopall-pl1-cwd1-"));
    dirsToClean.push(cwd1);
    await mkdir(join(cwd1, ".claude", "hermes"), { recursive: true });
    await writeFile(join(cwd1, ".claude", "hermes", "daemon.pid"), `${dummy1}\n`);

    const cwd2 = await mkdtemp(join(tmpdir(), "hermes-stopall-pl1-cwd2-"));
    dirsToClean.push(cwd2);
    await mkdir(join(cwd2, ".claude", "hermes"), { recursive: true });
    await writeFile(join(cwd2, ".claude", "hermes", "daemon.pid"), `${dummy2}\n`);

    await writeFile(
      registryPath,
      JSON.stringify({
        daemons: [
          { pid: dummy1, cwd: cwd1, startedAt: new Date().toISOString() },
          { pid: dummy2, cwd: cwd2, startedAt: new Date().toISOString() },
        ],
      })
    );

    try {
      const result = await new Promise<SpawnResult>((resolve, reject) => {
        const child = spawn("bun", ["run", join(REPO_ROOT, "src/index.ts"), "--stop-all"], {
          env: {
            ...process.env,
            HERMES_PARENT_PID: String(dummy1),
            HERMES_DAEMON_REGISTRY: registryPath,
          },
          stdio: ["ignore", "pipe", "pipe"],
        });
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        child.stdout.on("data", (d) => stdout.push(Buffer.from(d)));
        child.stderr.on("data", (d) => stderr.push(Buffer.from(d)));
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error("stop-all subprocess timed out after 20s"));
        }, 20_000);
        child.on("error", (err) => {
          clearTimeout(timer);
          reject(err);
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          resolve({
            stdout: Buffer.concat(stdout).toString("utf8"),
            stderr: Buffer.concat(stderr).toString("utf8"),
            exitCode: code ?? 1,
          });
        });
      });

      expect(result.exitCode).toBe(0);

      // Give the kernel a tick to register dummy-2's death.
      await new Promise((r) => setTimeout(r, 200));

      // dummy-1 (the parent daemon pid) must still be alive.
      let dummy1Alive = true;
      try {
        process.kill(dummy1, 0);
      } catch {
        dummy1Alive = false;
      }
      expect(dummy1Alive).toBe(true);

      // dummy-2 must be dead — stopAll should have SIGTERMed it.
      // Wait up to 2s for it to actually exit.
      const deadline = Date.now() + 2_000;
      let dummy2Alive = true;
      while (Date.now() < deadline) {
        try {
          process.kill(dummy2, 0);
        } catch {
          dummy2Alive = false;
          break;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(dummy2Alive).toBe(false);

      // Registry file: dummy-1's row must still be present (we skipped
      // it so we must not strip it); dummy-2's row must be removed.
      const raw = await readFile(registryPath, "utf8").catch(() => "");
      let parsed: { daemons?: Array<{ pid: number }> } = {};
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = {};
      }
      const pids = (parsed.daemons ?? []).map((d) => d.pid);
      expect(pids).toContain(dummy1);
      expect(pids).not.toContain(dummy2);

      // dummy-1's pid-file must still exist — we skipped it.
      const dummy1PidFileStillThere = await Bun.file(join(cwd1, ".claude", "hermes", "daemon.pid"))
        .text()
        .then(() => true)
        .catch(() => false);
      expect(dummy1PidFileStillThere).toBe(true);

      // Log hint: the skip message should mention dummy-1's pid.
      expect(result.stdout).toContain(String(dummy1));
      expect(result.stdout.toLowerCase()).toMatch(/skip|parent/);
    } finally {
      for (const pid of pidsToKill) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
      for (const d of dirsToClean) {
        await rm(d, { recursive: true, force: true }).catch(() => {});
      }
    }
  }, 30_000);

  // ---------------------------------------------------------------------
  // PL-3: stopAll() unlinks pid-files and registry rows immediately
  // after SIGTERM, before the daemon has actually exited, opening a
  // race with a new `start`.
  //
  // Agreed fix: after process.kill(pid, "SIGTERM"), poll
  // process.kill(pid, 0) with a short budget (~2000ms, sleeping 50ms)
  // until it throws; only then unlink the pid-file / unregister.
  //
  // POSIX-only: Windows `process.kill(pid, "SIGTERM")` calls
  // TerminateProcess under the hood, which is synchronous and
  // uncatchable — no graceful-shutdown window, so the race we're
  // guarding against does not exist on Windows.
  // ---------------------------------------------------------------------
  test.skipIf(process.platform === "win32")(
    "PL-3: stopAll() waits for the daemon to actually exit before unlinking pid-file",
    async () => {
      const pidsToKill: number[] = [];
      const dirsToClean: string[] = [];

      // Dummy daemon that intentionally takes ~500ms to exit after
      // SIGTERM. If stopAll unlinks the pid-file synchronously after
      // SIGTERM (the bug), the pid-file will be gone long before the
      // process is actually dead.
      const spawnSlowDummy = (): Promise<number> => {
        return new Promise((resolve, reject) => {
          const p = spawn(
            "node",
            [
              "-e",
              "process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),500));process.stdout.write('ready\\n');setInterval(()=>{},1<<30)",
            ],
            { stdio: ["ignore", "pipe", "ignore"] }
          );
          let settled = false;
          const finish = (err?: Error) => {
            if (settled) return;
            settled = true;
            if (err) reject(err);
            else if (p.pid) resolve(p.pid);
            else reject(new Error("slow dummy has no pid"));
          };
          p.stdout?.on("data", (buf: Buffer) => {
            if (buf.toString().includes("ready")) finish();
          });
          p.on("error", (err) => finish(err));
          setTimeout(() => finish(), 2_000);
        });
      };

      const slowPid = await spawnSlowDummy();
      pidsToKill.push(slowPid);

      const regDir = await mkdtemp(join(tmpdir(), "hermes-stopall-pl3-reg-"));
      dirsToClean.push(regDir);
      const registryPath = join(regDir, "daemons.json");

      const cwd = await mkdtemp(join(tmpdir(), "hermes-stopall-pl3-cwd-"));
      dirsToClean.push(cwd);
      await mkdir(join(cwd, ".claude", "hermes"), { recursive: true });
      const pidFilePath = join(cwd, ".claude", "hermes", "daemon.pid");
      await writeFile(pidFilePath, `${slowPid}\n`);

      await writeFile(
        registryPath,
        JSON.stringify({
          daemons: [{ pid: slowPid, cwd, startedAt: new Date().toISOString() }],
        })
      );

      try {
        const result = await new Promise<SpawnResult>((resolve, reject) => {
          const child = spawn("bun", ["run", join(REPO_ROOT, "src/index.ts"), "--stop-all"], {
            env: {
              ...process.env,
              // No HERMES_PARENT_PID: slowPid must not be skipped.
              HERMES_DAEMON_REGISTRY: registryPath,
            },
            stdio: ["ignore", "pipe", "pipe"],
          });
          const stdout: Buffer[] = [];
          const stderr: Buffer[] = [];
          child.stdout.on("data", (d) => stdout.push(Buffer.from(d)));
          child.stderr.on("data", (d) => stderr.push(Buffer.from(d)));
          const timer = setTimeout(() => {
            child.kill("SIGKILL");
            reject(new Error("stop-all subprocess timed out after 20s"));
          }, 20_000);
          child.on("error", (err) => {
            clearTimeout(timer);
            reject(err);
          });
          child.on("close", (code) => {
            clearTimeout(timer);
            resolve({
              stdout: Buffer.concat(stdout).toString("utf8"),
              stderr: Buffer.concat(stderr).toString("utf8"),
              exitCode: code ?? 1,
            });
          });
        });

        expect(result.exitCode).toBe(0);

        // The moment `--stop-all` returns, the slow daemon MUST already
        // be gone. If stopAll raced and unlinked the pid-file while the
        // daemon was still shutting down, `process.kill(pid, 0)` would
        // still succeed here.
        let stillAlive = true;
        try {
          process.kill(slowPid, 0);
          stillAlive = true;
        } catch {
          stillAlive = false;
        }
        expect(stillAlive).toBe(false);

        // And the pid-file should be gone only after the daemon exited —
        // since the daemon is confirmed dead above, the pid-file must
        // also be gone now.
        const pidFileStillThere = await Bun.file(pidFilePath)
          .text()
          .then(() => true)
          .catch(() => false);
        expect(pidFileStillThere).toBe(false);
      } finally {
        for (const pid of pidsToKill) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {}
        }
        for (const d of dirsToClean) {
          await rm(d, { recursive: true, force: true }).catch(() => {});
        }
      }
    },
    30_000
  );
});
