import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync } from "node:fs";
import * as fsPromises from "node:fs/promises";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  type DaemonEntry,
  defaultRegistryPath,
  listDaemons,
  registerDaemon,
  unregisterDaemon,
} from "./daemon-registry";
import * as registry from "./daemon-registry";

let dir: string;
let registryPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "hermes-reg-"));
  registryPath = join(dir, "daemons.json");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("daemon-registry — basic CRUD", () => {
  test("listDaemons on missing file returns empty array", async () => {
    expect(await listDaemons({ path: registryPath })).toEqual([]);
  });

  test("registerDaemon writes a new entry that listDaemons returns", async () => {
    await registerDaemon({ pid: 111, cwd: "/proj/a" }, { path: registryPath });
    const list = await listDaemons({ path: registryPath });
    expect(list.length).toBe(1);
    expect(list[0].pid).toBe(111);
    expect(list[0].cwd).toBe("/proj/a");
    expect(typeof list[0].startedAt).toBe("string");
  });

  test("two registers under different pids both end up in the registry", async () => {
    await registerDaemon({ pid: 111, cwd: "/a" }, { path: registryPath });
    await registerDaemon({ pid: 222, cwd: "/b" }, { path: registryPath });
    const list = await listDaemons({ path: registryPath });
    expect(list.map((d) => d.pid).sort()).toEqual([111, 222]);
  });

  test("re-register on the same pid replaces the previous entry (idempotent)", async () => {
    await registerDaemon({ pid: 111, cwd: "/old" }, { path: registryPath });
    await registerDaemon({ pid: 111, cwd: "/new" }, { path: registryPath });
    const list = await listDaemons({ path: registryPath });
    expect(list.length).toBe(1);
    expect(list[0].cwd).toBe("/new");
  });

  test("unregisterDaemon by pid removes the entry", async () => {
    await registerDaemon({ pid: 111, cwd: "/a" }, { path: registryPath });
    await registerDaemon({ pid: 222, cwd: "/b" }, { path: registryPath });
    await unregisterDaemon(111, { path: registryPath });
    const list = await listDaemons({ path: registryPath });
    expect(list.length).toBe(1);
    expect(list[0].pid).toBe(222);
  });

  test("unregisterDaemon on a missing pid is a no-op", async () => {
    await registerDaemon({ pid: 111, cwd: "/a" }, { path: registryPath });
    await expect(unregisterDaemon(999, { path: registryPath })).resolves.toBeUndefined();
    const list = await listDaemons({ path: registryPath });
    expect(list.map((d) => d.pid)).toEqual([111]);
  });

  test("removing the last entry deletes the file", async () => {
    await registerDaemon({ pid: 111, cwd: "/a" }, { path: registryPath });
    await unregisterDaemon(111, { path: registryPath });
    await expect(readFile(registryPath, "utf8")).rejects.toThrow();
  });
});

describe("daemon-registry — concurrent writers", () => {
  // Mirrors the sessionManager legacy-JSON fix: two processes that hit
  // register() at exactly the same moment must both end up in the file.
  // Without serialization, the second writer clobbers the first.
  test("concurrent registerDaemon for two pids: both survive", async () => {
    await Promise.all([
      registerDaemon({ pid: 111, cwd: "/a" }, { path: registryPath }),
      registerDaemon({ pid: 222, cwd: "/b" }, { path: registryPath }),
    ]);
    const list = await listDaemons({ path: registryPath });
    expect(list.map((d) => d.pid).sort()).toEqual([111, 222]);
  });

  test("concurrent register + unregister on different pids: state is consistent", async () => {
    await registerDaemon({ pid: 111, cwd: "/a" }, { path: registryPath });
    await Promise.all([
      registerDaemon({ pid: 222, cwd: "/b" }, { path: registryPath }),
      unregisterDaemon(111, { path: registryPath }),
    ]);
    const list = await listDaemons({ path: registryPath });
    expect(list.map((d) => d.pid)).toEqual([222]);
  });
});

describe("daemon-registry — malformed file recovery", () => {
  test("garbage JSON: listDaemons returns empty (does not throw)", async () => {
    await writeFile(registryPath, "not valid json {", "utf8");
    const list = await listDaemons({ path: registryPath });
    expect(list).toEqual([]);
  });

  test("garbage JSON gets overwritten cleanly on next register", async () => {
    await writeFile(registryPath, "garbage", "utf8");
    await registerDaemon({ pid: 111, cwd: "/a" }, { path: registryPath });
    const list = await listDaemons({ path: registryPath });
    expect(list.length).toBe(1);
    expect(list[0].pid).toBe(111);
  });

  test("entries without required fields are dropped on read", async () => {
    await writeFile(
      registryPath,
      JSON.stringify({ daemons: [{ pid: 111, cwd: "/a", startedAt: "x" }, { pid: "bogus" }, {}] }),
      "utf8"
    );
    const list = await listDaemons({ path: registryPath });
    expect(list.length).toBe(1);
    expect(list[0].pid).toBe(111);
  });
});

describe("daemon-registry — HERMES_DAEMON_REGISTRY env var", () => {
  // Existed because the daemon-boot integration test was polluting the
  // user's REAL ~/.claude/hermes/daemons.json with stale tmp-dir entries.
  // The env var lets callers (and that test) point the registry at an
  // isolated tmp file without threading opts.path through every call.

  test("env var path is used when opts.path is omitted", async () => {
    const envPath = join(dir, "from-env.json");
    const prev = process.env.HERMES_DAEMON_REGISTRY;
    process.env.HERMES_DAEMON_REGISTRY = envPath;
    try {
      await registerDaemon({ pid: 555, cwd: "/from-env" });
      // listDaemons() with no opts should also pick up the env var.
      const list = await listDaemons();
      expect(list.map((d) => d.pid)).toContain(555);
      // And the file should have been written at the env-var path.
      expect(await readFile(envPath, "utf8")).toContain('"pid": 555');
    } finally {
      if (prev === undefined) delete process.env.HERMES_DAEMON_REGISTRY;
      else process.env.HERMES_DAEMON_REGISTRY = prev;
      await unregisterDaemon(555, { path: envPath }).catch(() => {});
    }
  });

  test("opts.path beats env var (explicit > implicit)", async () => {
    const envPath = join(dir, "from-env.json");
    const optsPath = join(dir, "from-opts.json");
    const prev = process.env.HERMES_DAEMON_REGISTRY;
    process.env.HERMES_DAEMON_REGISTRY = envPath;
    try {
      await registerDaemon({ pid: 666, cwd: "/explicit" }, { path: optsPath });
      // env-var path stays empty
      await expect(readFile(envPath, "utf8")).rejects.toThrow();
      // opts.path got the write
      expect(await readFile(optsPath, "utf8")).toContain('"pid": 666');
    } finally {
      if (prev === undefined) delete process.env.HERMES_DAEMON_REGISTRY;
      else process.env.HERMES_DAEMON_REGISTRY = prev;
    }
  });

  test("empty env var is treated as unset (falls back to default)", async () => {
    const prev = process.env.HERMES_DAEMON_REGISTRY;
    process.env.HERMES_DAEMON_REGISTRY = "";
    try {
      // We can't write through default safely from a unit test (it would
      // touch ~/.claude/hermes/daemons.json), so we only assert the
      // resolution path doesn't throw and that opts.path still wins.
      await registerDaemon({ pid: 777, cwd: "/x" }, { path: registryPath });
      expect((await listDaemons({ path: registryPath })).map((d) => d.pid)).toContain(777);
    } finally {
      if (prev === undefined) delete process.env.HERMES_DAEMON_REGISTRY;
      else process.env.HERMES_DAEMON_REGISTRY = prev;
    }
  });
});

describe("daemon-registry — DaemonEntry shape contract", () => {
  test("entries have pid (number), cwd (string), startedAt (ISO-ish)", async () => {
    await registerDaemon({ pid: 111, cwd: "/a" }, { path: registryPath });
    const list = await listDaemons({ path: registryPath });
    const entry: DaemonEntry = list[0];
    expect(typeof entry.pid).toBe("number");
    expect(typeof entry.cwd).toBe("string");
    expect(entry.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe("daemon-registry — atomic write (crash-mid-write safety)", () => {
  // PL-5: writeEntries() uses plain fs/promises.writeFile. If the process
  // crashes or is killed mid-write, the file is truncated and the very
  // next readEntries() parses it as [] (via the JSON.parse catch), so
  // `stopAll` reports "No running daemons found" while daemons are still
  // alive. Fix: write to a sibling tmp path and atomically rename.
  //
  // This test simulates that crash by monkey-patching writeFile to write
  // only half the bytes to the *final* path and then throw. If the
  // production code truly writes atomically (tmp + rename), the final
  // path will either contain the prior valid content or not exist yet —
  // either way, listDaemons() must still return the prior entry.
  test("crash during write leaves prior registry content intact", async () => {
    // Seed: one valid daemon entry written normally.
    await registerDaemon({ pid: 111, cwd: "/seed" }, { path: registryPath });
    expect((await listDaemons({ path: registryPath })).length).toBe(1);

    const realWriteFile = fsPromises.writeFile;
    let crashed = false;
    const crashingWriteFile: typeof fsPromises.writeFile = (async (
      target: Parameters<typeof fsPromises.writeFile>[0],
      data: Parameters<typeof fsPromises.writeFile>[1],
      options?: Parameters<typeof fsPromises.writeFile>[2]
    ) => {
      // Only sabotage the next write to the final registry path; let any
      // writes to sibling tmp paths (e.g. `<path>.tmp.<pid>-<rand>`)
      // succeed so the atomic-write fix is what the assertion measures.
      if (typeof target === "string" && target === registryPath && !crashed) {
        crashed = true;
        const body = typeof data === "string" ? data : String(data);
        const half = body.slice(0, Math.floor(body.length / 2));
        await realWriteFile(target, half, options);
        throw new Error("simulated crash mid-write");
      }
      return realWriteFile(target as never, data as never, options as never);
    }) as typeof fsPromises.writeFile;

    mock.module("node:fs/promises", () => ({
      ...fsPromises,
      writeFile: crashingWriteFile,
      default: { ...fsPromises, writeFile: crashingWriteFile },
    }));

    try {
      // Trigger a write that will hit the sabotaged writeFile.
      await registerDaemon({ pid: 222, cwd: "/new" }, { path: registryPath }).catch(() => undefined);

      // Restore the real writeFile before asserting so listDaemons() is
      // unaffected by the mock (it only reads).
      mock.module("node:fs/promises", () => ({
        ...fsPromises,
        writeFile: realWriteFile,
        default: { ...fsPromises, writeFile: realWriteFile },
      }));

      // The registry must still be parseable and must still contain the
      // originally-seeded entry. Today this fails because the plain
      // writeFile left a half-written file and readEntries returns [].
      const list = await listDaemons({ path: registryPath });
      expect(list.length).toBeGreaterThanOrEqual(1);
      expect(list.map((d) => d.pid)).toContain(111);
    } finally {
      mock.module("node:fs/promises", () => ({
        ...fsPromises,
        writeFile: realWriteFile,
        default: { ...fsPromises, writeFile: realWriteFile },
      }));
    }
  });
});

describe("daemon-registry — project-local registry path", () => {
  // Phase X: the registry is no longer global. It lives at
  // <cwd>/.claude/hermes/daemons.json so each project owns its own
  // daemon list and Windows never needs to trust `homedir()`.
  test("defaultRegistryPath(cwd) is rooted under the given cwd", () => {
    const projRoot = join(dir, "projA");
    expect(defaultRegistryPath(projRoot)).toBe(join(projRoot, ".claude", "hermes", "daemons.json"));
  });

  test("defaultRegistryPath() with no arg falls back to process.cwd()", () => {
    const orig = process.cwd();
    try {
      process.chdir(dir);
      expect(defaultRegistryPath()).toBe(join(dir, ".claude", "hermes", "daemons.json"));
    } finally {
      process.chdir(orig);
    }
  });

  test("daemon-registry.ts source no longer imports node:os (homedir is gone)", async () => {
    // Read the production source as a string and assert homedir/node:os
    // are not imported. The spec explicitly forbids the homedir import so
    // the registry can't silently drift back to a global path on refactor.
    // `migrateGlobalRegistry` takes `home` as a required parameter — the
    // caller in start.ts passes `homedir()` explicitly.
    const src = await readFile(join(import.meta.dir, "daemon-registry.ts"), "utf8");
    expect(src.includes("node:os")).toBe(false);
    expect(/\bhomedir\b/.test(src)).toBe(false);
  });
});

describe("daemon-registry — migrateGlobalRegistry", () => {
  // Contract: read <home>/.claude/hermes/daemons.json, move entries whose
  // .cwd equals the current cwd into the project-local file, rewrite (or
  // unlink) the global file, and report counts. Idempotent.
  //
  // All paths are mkdtemp-scoped so the real user home is never touched.
  test("migrateGlobalRegistry is an exported function", () => {
    expect(typeof registry.migrateGlobalRegistry).toBe("function");
  });

  test("no global file: returns { migrated: 0, remainingGlobal: 0 }", async () => {
    const home = join(dir, "home");
    const cwd = join(dir, "proj");
    await mkdir(home, { recursive: true });
    await mkdir(cwd, { recursive: true });

    const result = await registry.migrateGlobalRegistry({ home, cwd });
    expect(result).toEqual({ migrated: 0, remainingGlobal: 0 });
    // No files should have been created.
    expect(existsSync(join(home, ".claude", "hermes", "daemons.json"))).toBe(false);
    expect(existsSync(join(cwd, ".claude", "hermes", "daemons.json"))).toBe(false);
  });

  test("all entries match cwd: moves them and unlinks the global file", async () => {
    const home = join(dir, "home");
    const cwd = join(dir, "proj");
    const globalPath = join(home, ".claude", "hermes", "daemons.json");
    const localPath = join(cwd, ".claude", "hermes", "daemons.json");

    await mkdir(dirname(globalPath), { recursive: true });
    await writeFile(
      globalPath,
      JSON.stringify({
        daemons: [
          { pid: 1001, cwd, startedAt: "2025-01-01T00:00:00Z" },
          { pid: 1002, cwd, startedAt: "2025-01-01T01:00:00Z" },
        ],
      }),
      "utf8"
    );

    const result = await registry.migrateGlobalRegistry({ home, cwd });
    expect(result.migrated).toBe(2);
    expect(result.remainingGlobal).toBe(0);

    // Global file is gone.
    expect(existsSync(globalPath)).toBe(false);
    // Local file contains both entries.
    const localRaw = await readFile(localPath, "utf8");
    const localParsed = JSON.parse(localRaw) as { daemons: Array<{ pid: number }> };
    expect(localParsed.daemons.map((d) => d.pid).sort()).toEqual([1001, 1002]);
  });

  test("mixed: matching entries move, non-matching stay in global", async () => {
    const home = join(dir, "home");
    const cwd = join(dir, "proj");
    const otherCwd = join(dir, "other");
    const globalPath = join(home, ".claude", "hermes", "daemons.json");
    const localPath = join(cwd, ".claude", "hermes", "daemons.json");

    await mkdir(dirname(globalPath), { recursive: true });
    await writeFile(
      globalPath,
      JSON.stringify({
        daemons: [
          { pid: 1001, cwd, startedAt: "2025-01-01T00:00:00Z" },
          { pid: 2002, cwd: otherCwd, startedAt: "2025-01-01T01:00:00Z" },
          { pid: 1003, cwd, startedAt: "2025-01-01T02:00:00Z" },
        ],
      }),
      "utf8"
    );

    const result = await registry.migrateGlobalRegistry({ home, cwd });
    expect(result.migrated).toBe(2);
    expect(result.remainingGlobal).toBe(1);

    // Global file still exists and contains ONLY the non-matching entry.
    const globalRaw = await readFile(globalPath, "utf8");
    const globalParsed = JSON.parse(globalRaw) as { daemons: Array<{ pid: number; cwd: string }> };
    expect(globalParsed.daemons.length).toBe(1);
    expect(globalParsed.daemons[0].pid).toBe(2002);
    expect(globalParsed.daemons[0].cwd).toBe(otherCwd);

    // Local file has the two matching entries.
    const localParsed = JSON.parse(await readFile(localPath, "utf8")) as {
      daemons: Array<{ pid: number }>;
    };
    expect(localParsed.daemons.map((d) => d.pid).sort()).toEqual([1001, 1003]);
  });

  test("idempotent: running twice produces the same final state", async () => {
    const home = join(dir, "home");
    const cwd = join(dir, "proj");
    const globalPath = join(home, ".claude", "hermes", "daemons.json");
    const localPath = join(cwd, ".claude", "hermes", "daemons.json");

    await mkdir(dirname(globalPath), { recursive: true });
    await writeFile(
      globalPath,
      JSON.stringify({
        daemons: [{ pid: 1001, cwd, startedAt: "2025-01-01T00:00:00Z" }],
      }),
      "utf8"
    );

    const first = await registry.migrateGlobalRegistry({ home, cwd });
    expect(first.migrated).toBe(1);
    const firstLocal = await readFile(localPath, "utf8");

    const second = await registry.migrateGlobalRegistry({ home, cwd });
    expect(second).toEqual({ migrated: 0, remainingGlobal: 0 });
    // Local file unchanged after the second run.
    expect(await readFile(localPath, "utf8")).toBe(firstLocal);
    // Global file still absent.
    expect(existsSync(globalPath)).toBe(false);
  });
});
