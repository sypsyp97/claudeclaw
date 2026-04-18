/**
 * Red-TDD tests for `migrateLegacyMemory(cwd)`.
 *
 * Contract (copied from spec for reference):
 *   - If `legacyMemoryDir(cwd)` does not exist → returns
 *     `{ moved: [], skipped: [] }`.
 *   - If `memoryDir(cwd)` does not exist and legacy does → moves the whole
 *     tree; returns `{ moved: [<relative paths>], skipped: [] }`.
 *   - If both exist → per-file: legacy-only files are moved to new path;
 *     files that exist in both are left at new path and legacy copy stays;
 *     `skipped` contains legacy paths that were NOT moved.
 *   - Idempotent: second call on a fresh legacy tree is a no-op.
 *
 * The impl may live in `src/memory/files.ts` or a sibling — we import from
 * `./files` first (spec-preferred) with a fallback to `./migrate` so either
 * placement wins. All paths use `mkdtemp` under `tmpdir()`; no real home.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

type MigrateResult = { moved: string[]; skipped: string[] };
type Migrator = (cwd: string) => Promise<MigrateResult>;

async function loadMigrator(): Promise<Migrator> {
  // Prefer the spec-preferred home (files.ts). Fall back to a sibling
  // migrate.ts so the impl agent can put it either place without breaking
  // the red test. If neither exports it, the test fails with a clear
  // assertion rather than an unresolved-import explosion.
  const candidates = ["./files", "./migrate"];
  for (const mod of candidates) {
    try {
      const loaded = (await import(mod)) as Record<string, unknown>;
      const fn = loaded.migrateLegacyMemory;
      if (typeof fn === "function") return fn as Migrator;
    } catch {
      // keep probing
    }
  }
  throw new Error("migrateLegacyMemory is not exported from src/memory/files.ts nor src/memory/migrate.ts");
}

let tmp: string;
let legacy: string;
let neo: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "hermes-mem-migrate-"));
  legacy = join(tmp, ".claude", "hermes", "memory");
  neo = join(tmp, "memory");
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("migrateLegacyMemory — branches", () => {
  test("neither legacy nor new exists: returns empty moved+skipped", async () => {
    const migrate = await loadMigrator();
    const result = await migrate(tmp);
    expect(result).toEqual({ moved: [], skipped: [] });
    // No directories should have been created.
    expect(existsSync(legacy)).toBe(false);
    expect(existsSync(neo)).toBe(false);
  });

  test("legacy-only: moves the whole tree to project-root memory/", async () => {
    await mkdir(join(legacy, "channels"), { recursive: true });
    await writeFile(join(legacy, "MEMORY.md"), "mem\n", "utf8");
    await writeFile(join(legacy, "USER.md"), "user\n", "utf8");
    await writeFile(join(legacy, "channels", "c1.md"), "c1\n", "utf8");

    const migrate = await loadMigrator();
    const result = await migrate(tmp);

    // New path has the files now.
    expect(await readFile(join(neo, "MEMORY.md"), "utf8")).toBe("mem\n");
    expect(await readFile(join(neo, "USER.md"), "utf8")).toBe("user\n");
    expect(await readFile(join(neo, "channels", "c1.md"), "utf8")).toBe("c1\n");

    expect(result.skipped).toEqual([]);
    // `moved` reports relative paths — assert length + contents, not order.
    expect(result.moved.length).toBe(3);
    const normalized = result.moved.map((p) => p.replace(/\\/g, "/")).sort();
    expect(normalized).toEqual(["MEMORY.md", "USER.md", "channels/c1.md"]);
  });

  test("both exist: new-path files win; legacy-only files move; skipped names legacy collisions", async () => {
    // Legacy tree: MEMORY.md (also in new), USER.md (legacy-only)
    await mkdir(legacy, { recursive: true });
    await writeFile(join(legacy, "MEMORY.md"), "legacy-mem\n", "utf8");
    await writeFile(join(legacy, "USER.md"), "legacy-user\n", "utf8");

    // New tree already has a MEMORY.md — that file is authoritative.
    await mkdir(neo, { recursive: true });
    await writeFile(join(neo, "MEMORY.md"), "new-mem\n", "utf8");

    const migrate = await loadMigrator();
    const result = await migrate(tmp);

    // New-path MEMORY.md is preserved verbatim.
    expect(await readFile(join(neo, "MEMORY.md"), "utf8")).toBe("new-mem\n");
    // Legacy copy of the collision stays put (not deleted).
    expect(await readFile(join(legacy, "MEMORY.md"), "utf8")).toBe("legacy-mem\n");
    // Legacy-only file moved to the new path.
    expect(await readFile(join(neo, "USER.md"), "utf8")).toBe("legacy-user\n");

    // moved includes the USER.md-only entry; skipped includes the MEMORY.md collision.
    const movedNorm = result.moved.map((p) => p.replace(/\\/g, "/")).sort();
    const skippedNorm = result.skipped.map((p) => p.replace(/\\/g, "/")).sort();
    expect(movedNorm).toEqual(["USER.md"]);
    expect(skippedNorm).toEqual(["MEMORY.md"]);
  });

  test("idempotent: second call after a clean legacy-only migration is a no-op", async () => {
    await mkdir(legacy, { recursive: true });
    await writeFile(join(legacy, "MEMORY.md"), "mem\n", "utf8");

    const migrate = await loadMigrator();
    const first = await migrate(tmp);
    expect(first.moved.length).toBe(1);

    // After the first migration, the legacy file has been moved away; the
    // legacy dir may be empty or removed. Either way, the second call
    // should return `{ moved: [], skipped: [] }` and touch nothing.
    const second = await migrate(tmp);
    expect(second).toEqual({ moved: [], skipped: [] });
    expect(await readFile(join(neo, "MEMORY.md"), "utf8")).toBe("mem\n");
  });
});
