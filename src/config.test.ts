import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// config.ts now resolves its filesystem paths lazily via `src/paths.ts` helpers,
// so we only need to chdir before the first call (not before module load). We
// still do the chdir in beforeAll for clarity, and reloadSettings() is used to
// bypass the in-memory `cached` Settings object between tests whenever the
// on-disk settings.json changes.

const ORIG_CWD = process.cwd();
const TEMP_DIR = join(tmpdir(), `hermes-config-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const HERMES_DIR = join(TEMP_DIR, ".claude", "hermes");
const SETTINGS_FILE = join(HERMES_DIR, "settings.json");

let config: typeof import("./config");

beforeAll(async () => {
  await mkdir(HERMES_DIR, { recursive: true });
  process.chdir(TEMP_DIR);
  config = await import("./config");
});

afterAll(async () => {
  process.chdir(ORIG_CWD);
  await rm(TEMP_DIR, { recursive: true, force: true });
});

afterEach(async () => {
  // Remove the settings file between tests so each test starts clean. The
  // module-level `cached` Settings object is refreshed by calling
  // reloadSettings() (or a fresh loadSettings after a deletion + rewrite).
  await rm(SETTINGS_FILE, { force: true });
});

async function writeSettings(raw: string): Promise<void> {
  await writeFile(SETTINGS_FILE, raw);
}

describe("resolvePrompt", () => {
  test("returns literal string when prompt is plain text", async () => {
    expect(await config.resolvePrompt("hello world")).toBe("hello world");
  });

  test("does NOT treat plain prose ending in '.md' as a file path", async () => {
    // Old implementation would silently try to read "some-file.md" from cwd.
    // New contract: only the explicit @file: prefix triggers a read.
    expect(await config.resolvePrompt("see some-file.md for details")).toBe("see some-file.md for details");
  });

  test("does NOT treat a bare 'some.md' string as a file path", async () => {
    // Without the @file: prefix this is a literal, even if it happens to look
    // like a path.
    expect(await config.resolvePrompt("  some.md  ")).toBe("some.md");
  });

  test("reads prompt file contents only when the @file: prefix is used", async () => {
    const fixtureRel = "fixture.md";
    const fixtureAbs = join(TEMP_DIR, fixtureRel);
    await writeFile(fixtureAbs, "prompt body");
    try {
      expect(await config.resolvePrompt(`@file:${fixtureRel}`)).toBe("prompt body");
    } finally {
      await rm(fixtureAbs, { force: true });
    }
  });

  test("rejects absolute paths under @file: — refuses to read outside cwd", async () => {
    const fixtureAbs = join(TEMP_DIR, "abs-fixture.md");
    await writeFile(fixtureAbs, "should not be read");
    try {
      // Absolute paths (even ones that happen to resolve inside cwd) are not
      // accepted — the caller cannot bypass directory scoping with an absolute.
      const result = await config.resolvePrompt(`@file:${fixtureAbs}`);
      expect(result).not.toBe("should not be read");
      expect(result).toContain("@file:");
    } finally {
      await rm(fixtureAbs, { force: true });
    }
  });

  test("rejects paths containing `..` segments", async () => {
    const result = await config.resolvePrompt("@file:../escape.md");
    expect(result).toContain("@file:");
  });

  test("rejects paths that resolve outside cwd even without a literal '..'", async () => {
    // Construct a path that tries to escape via trailing ../ after a segment.
    const sneaky = "@file:legit/../../escape.md";
    const result = await config.resolvePrompt(sneaky);
    expect(result).toContain("@file:");
  });

  test("missing file under @file: falls back to the trimmed literal", async () => {
    expect(await config.resolvePrompt("@file:does-not-exist.md")).toBe("@file:does-not-exist.md");
  });
});

describe("loadSettings / reloadSettings", () => {
  test("returns defaults after initConfig on a fresh cwd", async () => {
    await config.initConfig();
    const settings = await config.reloadSettings();

    expect(settings.heartbeat.enabled).toBe(false);
    expect(settings.security.level).toBe("moderate");
    expect(settings.telegram.token).toBe("");
    expect(settings.telegram.allowedUserIds).toEqual([]);
    expect(settings.discord.token).toBe("");
    expect(settings.discord.allowedUserIds).toEqual([]);
  });

  test("invalid security.level falls back to 'moderate'", async () => {
    await writeSettings(
      JSON.stringify({
        security: { level: "bogus", allowedTools: [], disallowedTools: [] },
      })
    );
    const settings = await config.reloadSettings();
    expect(settings.security.level).toBe("moderate");
  });

  test("preserves Discord snowflake precision for values above Number.MAX_SAFE_INTEGER", async () => {
    // Both IDs exceed Number.MAX_SAFE_INTEGER (9007199254740992) and would be
    // mangled by a naive JSON.parse. The extractDiscordUserIds regex reads
    // them as strings directly from the raw JSON text.
    const rawText = `{
  "discord": {
    "token": "",
    "allowedUserIds": [1234567890123456789, 9999999999999999999],
    "listenChannels": []
  }
}
`;
    await writeSettings(rawText);
    const settings = await config.reloadSettings();

    expect(settings.discord.allowedUserIds).toContain("1234567890123456789");
    expect(settings.discord.allowedUserIds).toContain("9999999999999999999");
    // Guard against float-mangled variants sneaking in.
    for (const id of settings.discord.allowedUserIds) {
      expect(typeof id).toBe("string");
    }
  });

  test("plugins.preflightOnStart defaults to false (off unless explicitly enabled)", async () => {
    await config.initConfig();
    const settings = await config.reloadSettings();
    expect(settings.plugins.preflightOnStart).toBe(false);
  });

  test("plugins.preflightOnStart=true is honored from settings.json", async () => {
    await writeSettings(JSON.stringify({ plugins: { preflightOnStart: true } }));
    const settings = await config.reloadSettings();
    expect(settings.plugins.preflightOnStart).toBe(true);
  });

  test("plugins.preflightOnStart falls back to false on a non-boolean value", async () => {
    await writeSettings(JSON.stringify({ plugins: { preflightOnStart: "yes" } }));
    const settings = await config.reloadSettings();
    expect(settings.plugins.preflightOnStart).toBe(false);
  });

  test("reloadSettings bypasses cache and picks up on-disk changes", async () => {
    // Seed an initial settings file and prime the cache via reloadSettings
    // (loadSettings would return whatever a previous test left cached).
    await writeSettings(JSON.stringify({ telegram: { token: "first-token", allowedUserIds: [] } }));
    const first = await config.reloadSettings();
    expect(first.telegram.token).toBe("first-token");

    // Overwrite on disk; a plain loadSettings() should still return the cache.
    await writeSettings(JSON.stringify({ telegram: { token: "second-token", allowedUserIds: [] } }));
    const stillCached = await config.loadSettings();
    expect(stillCached.telegram.token).toBe("first-token");

    const refreshed = await config.reloadSettings();
    expect(refreshed.telegram.token).toBe("second-token");
  });
});
