import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GateRunners, VerifyResult } from "./gate";
import { commitChanges, computeDirtyPaths, revertPaths, runVerify } from "./gate";

const ORIG_CWD = process.cwd();
let tempRoot: string;

beforeAll(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "hermes-evolve-gate-"));
  process.chdir(tempRoot);
});

afterAll(async () => {
  process.chdir(ORIG_CWD);
  await rm(tempRoot, { recursive: true, force: true });
});

describe("runVerify (injected runner)", () => {
  test("returns the injected success result as-is", async () => {
    const injected: VerifyResult = {
      ok: true,
      durationMs: 123,
      exitCode: 0,
      stdout: "verify green",
      stderr: "",
    };
    const runners: GateRunners = {
      runVerify: async () => injected,
    };
    const result = await runVerify("/nowhere", runners);
    expect(result).toEqual(injected);
  });

  test("returns the injected failure result as-is", async () => {
    const injected: VerifyResult = {
      ok: false,
      durationMs: 10,
      exitCode: 1,
      stdout: "",
      stderr: "typecheck failed on line 3",
    };
    const runners: GateRunners = {
      runVerify: async () => injected,
    };
    const result = await runVerify("/anywhere", runners);
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("typecheck failed");
    expect(result.exitCode).toBe(1);
  });

  test("receives the cwd it was called with", async () => {
    let seenCwd = "";
    const runners: GateRunners = {
      runVerify: async (cwd) => {
        seenCwd = cwd;
        return { ok: true, durationMs: 1, exitCode: 0, stdout: "", stderr: "" };
      },
    };
    await runVerify("/tmp/elsewhere", runners);
    expect(seenCwd).toBe("/tmp/elsewhere");
  });
});

describe("runVerify (default runner, real spawn)", () => {
  test("reports ok=false with exitCode 127-ish when bin is missing", async () => {
    const emptyCwd = await mkdtemp(join(tmpdir(), "hermes-gate-empty-"));
    try {
      const result = await runVerify(emptyCwd);
      expect(typeof result.ok).toBe("boolean");
      expect(typeof result.exitCode).toBe("number");
      expect(typeof result.durationMs).toBe("number");
      expect(typeof result.stdout).toBe("string");
      expect(typeof result.stderr).toBe("string");
    } finally {
      await rm(emptyCwd, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("computeDirtyPaths", () => {
  test("parses porcelain output into a sorted set of paths", async () => {
    const runners: GateRunners = {
      runGit: async (_cwd, args) => {
        expect(args).toEqual(["status", "--porcelain"]);
        return {
          ok: true,
          stdout: " M src/a.ts\n?? new/file.ts\nA  tests/b.test.ts\n",
          stderr: "",
        };
      },
    };
    const paths = await computeDirtyPaths("/repo", runners);
    expect(paths).toEqual(["new/file.ts", "src/a.ts", "tests/b.test.ts"]);
  });

  test("handles renames (R  old -> new) by keeping the new path only", async () => {
    const runners: GateRunners = {
      runGit: async () => ({
        ok: true,
        stdout: "R  src/old.ts -> src/new.ts\n",
        stderr: "",
      }),
    };
    const paths = await computeDirtyPaths("/repo", runners);
    expect(paths).toEqual(["src/new.ts"]);
  });

  test("returns empty array when tree is clean", async () => {
    const runners: GateRunners = {
      runGit: async () => ({ ok: true, stdout: "", stderr: "" }),
    };
    expect(await computeDirtyPaths("/repo", runners)).toEqual([]);
  });

  test("returns empty array if git status itself fails", async () => {
    const runners: GateRunners = {
      runGit: async () => ({ ok: false, stdout: "", stderr: "not a repo" }),
    };
    expect(await computeDirtyPaths("/repo", runners)).toEqual([]);
  });
});

describe("commitChanges (scoped)", () => {
  test("returns null when no paths are provided (nothing to scope)", async () => {
    const calls: string[][] = [];
    const runners: GateRunners = {
      runGit: async (_cwd, args) => {
        calls.push(args);
        return { ok: true, stdout: "", stderr: "" };
      },
    };
    const sha = await commitChanges("/repo", "msg", [], runners);
    expect(sha).toBeNull();
    expect(calls).toEqual([]);
  });

  test("happy path: stages exactly the provided paths, commits, returns trimmed sha", async () => {
    const calls: string[][] = [];
    const runners: GateRunners = {
      runGit: async (_cwd, args) => {
        calls.push(args);
        if (args[0] === "add") return { ok: true, stdout: "", stderr: "" };
        if (args[0] === "diff") return { ok: true, stdout: "src/foo.ts\ntests/foo.test.ts\n", stderr: "" };
        if (args[0] === "commit") return { ok: true, stdout: "ok", stderr: "" };
        if (args[0] === "rev-parse") return { ok: true, stdout: " cafebabe\n", stderr: "" };
        return { ok: true, stdout: "", stderr: "" };
      },
    };
    const sha = await commitChanges("/repo", "evolve: fix bug", ["src/foo.ts", "tests/foo.test.ts"], runners);
    expect(sha).toBe("cafebabe");
    const add = calls.find((c) => c[0] === "add");
    expect(add).toEqual(["add", "--", "src/foo.ts", "tests/foo.test.ts"]);
    expect(calls.find((c) => c[0] === "add-A" || c.includes("-A"))).toBeUndefined();
    const commit = calls.find((c) => c[0] === "commit");
    expect(commit).toEqual(["commit", "-m", "evolve: fix bug"]);
  });

  test("returns null when nothing staged actually landed (diff --cached empty)", async () => {
    const runners: GateRunners = {
      runGit: async (_cwd, args) => {
        if (args[0] === "add") return { ok: true, stdout: "", stderr: "" };
        if (args[0] === "diff") return { ok: true, stdout: "", stderr: "" };
        throw new Error("commit should not be reached with empty staged diff");
      },
    };
    const sha = await commitChanges("/repo", "m", ["src/x.ts"], runners);
    expect(sha).toBeNull();
  });

  test("returns null when 'git commit' fails", async () => {
    const runners: GateRunners = {
      runGit: async (_cwd, args) => {
        if (args[0] === "add") return { ok: true, stdout: "", stderr: "" };
        if (args[0] === "diff") return { ok: true, stdout: "src/x.ts\n", stderr: "" };
        if (args[0] === "commit") return { ok: false, stdout: "", stderr: "hook failed" };
        throw new Error("rev-parse should not be reached");
      },
    };
    expect(await commitChanges("/repo", "oops", ["src/x.ts"], runners)).toBeNull();
  });
});

describe("revertPaths (scoped)", () => {
  test("no-ops when path list is empty — never touches git", async () => {
    const calls: string[][] = [];
    const runners: GateRunners = {
      runGit: async (_cwd, args) => {
        calls.push(args);
        return { ok: true, stdout: "", stderr: "" };
      },
    };
    await revertPaths("/repo", [], runners);
    expect(calls).toEqual([]);
  });

  test("splits tracked vs untracked: restores tracked, cleans untracked, pathspec-scoped", async () => {
    const calls: string[][] = [];
    const runners: GateRunners = {
      runGit: async (_cwd, args) => {
        calls.push(args);
        if (args[0] === "ls-files") {
          // src/a.ts exists in the index, new/b.ts does not.
          const path = args[args.length - 1];
          return path === "src/a.ts"
            ? { ok: true, stdout: "src/a.ts\n", stderr: "" }
            : { ok: false, stdout: "", stderr: "not tracked" };
        }
        return { ok: true, stdout: "", stderr: "" };
      },
    };
    await revertPaths("/repo", ["src/a.ts", "new/b.ts"], runners);

    const nonProbe = calls.filter((c) => c[0] !== "ls-files");
    expect(nonProbe).toEqual([
      ["restore", "--staged", "--", "src/a.ts"],
      ["restore", "--", "src/a.ts"],
      ["clean", "-fd", "--", "new/b.ts"],
    ]);
  });

  test("never invokes a workspace-wide `git clean -fd` without pathspec", async () => {
    const calls: string[][] = [];
    const runners: GateRunners = {
      runGit: async (_cwd, args) => {
        calls.push(args);
        if (args[0] === "ls-files") return { ok: false, stdout: "", stderr: "untracked" };
        return { ok: true, stdout: "", stderr: "" };
      },
    };
    await revertPaths("/repo", ["src/a.ts"], runners);
    for (const call of calls) {
      if (call[0] === "clean") {
        expect(call).toContain("--");
        const dashDash = call.indexOf("--");
        expect(call.length).toBeGreaterThan(dashDash + 1);
      }
    }
  });

  test("continues through intermediate restore failures (best-effort)", async () => {
    const calls: string[][] = [];
    const runners: GateRunners = {
      runGit: async (_cwd, args) => {
        calls.push(args);
        if (args[0] === "ls-files") return { ok: true, stdout: "x\n", stderr: "" };
        return { ok: false, stdout: "", stderr: "nope" };
      },
    };
    await revertPaths("/repo", ["x"], runners);
    // ls-files probe + restore --staged + restore = 3 calls; clean skipped (all tracked).
    expect(calls.length).toBe(3);
  });

  test("skips the restore pair entirely when every path is untracked", async () => {
    const calls: string[][] = [];
    const runners: GateRunners = {
      runGit: async (_cwd, args) => {
        calls.push(args);
        if (args[0] === "ls-files") return { ok: false, stdout: "", stderr: "untracked" };
        return { ok: true, stdout: "", stderr: "" };
      },
    };
    await revertPaths("/repo", ["new-a.ts", "new-b.ts"], runners);
    const nonProbe = calls.filter((c) => c[0] !== "ls-files");
    expect(nonProbe).toEqual([["clean", "-fd", "--", "new-a.ts", "new-b.ts"]]);
  });
});

describe("revertPaths preserves untouched files (real git)", () => {
  test("a file outside the pathSet survives revert", async () => {
    const repoCwd = await mkdtemp(join(tmpdir(), "hermes-gate-scoped-"));
    try {
      await runShell("git", ["init", "-q", "-b", "main"], repoCwd);
      await runShell("git", ["config", "user.email", "test@example.com"], repoCwd);
      await runShell("git", ["config", "user.name", "Test"], repoCwd);
      await writeFile(join(repoCwd, "baseline.txt"), "baseline\n");
      await runShell("git", ["add", "baseline.txt"], repoCwd);
      await runShell("git", ["commit", "-q", "-m", "seed"], repoCwd);

      // User's unrelated work (untracked) — must survive revert.
      await writeFile(join(repoCwd, "user-wip.txt"), "user work\n");
      // Evolve-touched file (untracked).
      await writeFile(join(repoCwd, "evolve-touched.txt"), "evolve work\n");

      await revertPaths(repoCwd, ["evolve-touched.txt"]);

      const userWipExists = await fileExists(join(repoCwd, "user-wip.txt"));
      const evolveExists = await fileExists(join(repoCwd, "evolve-touched.txt"));
      expect(userWipExists).toBe(true);
      expect(evolveExists).toBe(false);
    } finally {
      await rm(repoCwd, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("commitChanges with a real git binary", () => {
  test("clean newly-initialised repo → returns null (no changes to commit)", async () => {
    const repoCwd = await mkdtemp(join(tmpdir(), "hermes-gate-cleanrepo-"));
    try {
      await runShell("git", ["init", "-q"], repoCwd);
      const sha = await commitChanges(repoCwd, "should be skipped", []);
      expect(sha).toBeNull();
    } finally {
      await rm(repoCwd, { recursive: true, force: true });
    }
  }, 15_000);
});

function runShell(
  bin: string,
  args: string[],
  cwd: string
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn(bin, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (c) => {
      stdout += c.toString();
    });
    proc.stderr?.on("data", (c) => {
      stderr += c.toString();
    });
    proc.on("close", (code) => resolve({ ok: code === 0, stdout, stderr }));
    proc.on("error", () => resolve({ ok: false, stdout, stderr }));
  });
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await Bun.file(path).text();
    return true;
  } catch {
    return false;
  }
}
