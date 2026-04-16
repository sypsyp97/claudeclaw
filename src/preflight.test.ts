import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  enableInProject,
  extractRepo,
  isCached,
  isEnabledInProject,
  preflight,
  readJSON,
  writeJSON,
} from "./preflight";

let tempRoot: string;

beforeAll(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "hermes-preflight-"));
});

afterAll(async () => {
  await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
});

beforeEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
  await mkdir(tempRoot, { recursive: true });
});

describe("preflight module surface", () => {
  test("exports the entry function with the expected arity", () => {
    expect(typeof preflight).toBe("function");
    expect(preflight.length).toBe(1);
  });
});

describe("extractRepo", () => {
  test("strips github.com prefix and .git suffix from https URL", () => {
    expect(extractRepo("https://github.com/owner/repo.git")).toBe("owner/repo");
  });

  test("strips github.com prefix from https URL without .git", () => {
    expect(extractRepo("https://github.com/owner/repo")).toBe("owner/repo");
  });

  test("strips ssh-style github.com prefix", () => {
    expect(extractRepo("git@github.com:owner/repo.git")).toBe("owner/repo");
  });

  test("preserves hyphens inside repo names", () => {
    expect(extractRepo("https://github.com/org/group-name.git")).toBe("org/group-name");
  });

  test("returns input unchanged when not a github URL", () => {
    expect(extractRepo("not-a-url")).toBe("not-a-url");
  });
});

describe("readJSON / writeJSON round-trip", () => {
  test("readJSON returns the fallback when the file does not exist", () => {
    const path = join(tempRoot, "missing.json");
    expect(readJSON<{ a: number }>(path, { a: 99 })).toEqual({ a: 99 });
  });

  test("readJSON returns the fallback when the file is malformed JSON", async () => {
    const path = join(tempRoot, "bad.json");
    await writeFile(path, "{not json");
    expect(readJSON<{ x: string }>(path, { x: "default" })).toEqual({ x: "default" });
  });

  test("writeJSON creates parent directories before writing", () => {
    const path = join(tempRoot, "deep", "nested", "out.json");
    writeJSON(path, { ok: true });
    expect(existsSync(path)).toBe(true);
    expect(readJSON<{ ok: boolean }>(path, { ok: false })).toEqual({ ok: true });
  });

  test("writeJSON output ends with a trailing newline (POSIX-friendly)", async () => {
    const path = join(tempRoot, "out.json");
    writeJSON(path, { x: 1 });
    const text = await readFile(path, "utf-8");
    expect(text.endsWith("\n")).toBe(true);
  });
});

describe("isCached", () => {
  test("returns false when the install file does not exist", () => {
    const instFile = join(tempRoot, "installed_plugins.json");
    expect(isCached("foo@bar", instFile)).toBe(false);
  });

  test("returns false when the plugin key is absent", () => {
    const instFile = join(tempRoot, "installed_plugins.json");
    writeJSON(instFile, { version: 2, plugins: {} });
    expect(isCached("foo@bar", instFile)).toBe(false);
  });

  test("returns true when the plugin key has an entry whose installPath exists", () => {
    const instFile = join(tempRoot, "installed_plugins.json");
    const installPath = join(tempRoot, "installed", "foo");
    mkdirSync(installPath, { recursive: true });
    writeJSON(instFile, {
      version: 2,
      plugins: {
        "foo@bar": [
          {
            scope: "project",
            installPath,
            version: "abc123",
            installedAt: "2026-01-01T00:00:00Z",
            lastUpdated: "2026-01-01T00:00:00Z",
            gitCommitSha: "abc123",
            projectPath: "/tmp/project",
          },
        ],
      },
    });
    expect(isCached("foo@bar", instFile)).toBe(true);
  });

  test("returns false when the entry exists but the installPath has been removed", () => {
    const instFile = join(tempRoot, "installed_plugins.json");
    writeJSON(instFile, {
      version: 2,
      plugins: {
        "foo@bar": [
          {
            scope: "project",
            installPath: join(tempRoot, "ghost-dir-that-does-not-exist"),
            version: "abc123",
            installedAt: "2026-01-01T00:00:00Z",
            lastUpdated: "2026-01-01T00:00:00Z",
            gitCommitSha: "abc123",
            projectPath: "/tmp/project",
          },
        ],
      },
    });
    expect(isCached("foo@bar", instFile)).toBe(false);
  });
});

describe("isEnabledInProject / enableInProject", () => {
  test("isEnabledInProject returns false when no settings file exists", () => {
    expect(isEnabledInProject("foo@bar", tempRoot)).toBe(false);
  });

  test("isEnabledInProject returns false when enabledPlugins is missing", async () => {
    await mkdir(join(tempRoot, ".claude"), { recursive: true });
    writeJSON(join(tempRoot, ".claude", "settings.json"), { other: "value" });
    expect(isEnabledInProject("foo@bar", tempRoot)).toBe(false);
  });

  test("enableInProject creates settings.json and sets the plugin flag", () => {
    enableInProject("foo@bar", tempRoot);
    expect(isEnabledInProject("foo@bar", tempRoot)).toBe(true);

    const settings = readJSON<{ enabledPlugins: Record<string, boolean> }>(
      join(tempRoot, ".claude", "settings.json"),
      { enabledPlugins: {} }
    );
    expect(settings.enabledPlugins["foo@bar"]).toBe(true);
  });

  test("enableInProject preserves unrelated settings keys", async () => {
    await mkdir(join(tempRoot, ".claude"), { recursive: true });
    writeJSON(join(tempRoot, ".claude", "settings.json"), {
      statusLine: { type: "command", command: "node x.cjs" },
      somethingElse: 42,
    });
    enableInProject("foo@bar", tempRoot);

    const settings = readJSON<Record<string, unknown>>(join(tempRoot, ".claude", "settings.json"), {});
    expect(settings.statusLine).toEqual({ type: "command", command: "node x.cjs" });
    expect(settings.somethingElse).toBe(42);
    expect((settings.enabledPlugins as Record<string, boolean>)["foo@bar"]).toBe(true);
  });

  test("enableInProject is idempotent — second call doesn't change state", () => {
    enableInProject("foo@bar", tempRoot);
    const before = readJSON(join(tempRoot, ".claude", "settings.json"), {});
    enableInProject("foo@bar", tempRoot);
    const after = readJSON(join(tempRoot, ".claude", "settings.json"), {});
    expect(after).toEqual(before);
  });
});
