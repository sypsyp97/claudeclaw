import { describe, expect, test } from "bun:test";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

const REPO_ROOT = process.cwd();

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe("plugin install-time contract", () => {
  test("plugin.json declares the expected plugin name and version", async () => {
    const text = await readFile(join(REPO_ROOT, ".claude-plugin", "plugin.json"), "utf8");
    const parsed = JSON.parse(text);
    expect(parsed.name).toBe("claude-hermes");
    expect(typeof parsed.version).toBe("string");
    expect(parsed.version.length).toBeGreaterThan(0);
  });

  test("marketplace.json points at this repo as the plugin source", async () => {
    const text = await readFile(join(REPO_ROOT, ".claude-plugin", "marketplace.json"), "utf8");
    const parsed = JSON.parse(text);
    expect(parsed.name).toBe("claude-hermes");
    expect(Array.isArray(parsed.plugins)).toBe(true);
    expect(parsed.plugins.length).toBeGreaterThan(0);
    const hermes = parsed.plugins.find((p: { name?: string }) => p.name === "claude-hermes");
    expect(hermes).toBeDefined();
    expect(hermes.source).toBe("./");
  });

  test("every ${CLAUDE_PLUGIN_ROOT}/... path referenced from commands/*.md exists", async () => {
    const dir = join(REPO_ROOT, "commands");
    const entries = await readdir(dir);
    const broken: string[] = [];

    for (const name of entries) {
      if (!name.endsWith(".md")) continue;
      const text = await readFile(join(dir, name), "utf8");
      // Match ${CLAUDE_PLUGIN_ROOT}/<relpath> — relpath is the run target.
      const matches = text.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([^\s`)>]+)/g);
      for (const m of matches) {
        const rel = m[1];
        const abs = join(REPO_ROOT, rel);
        if (!(await exists(abs))) {
          broken.push(`${name} -> ${rel}`);
        }
      }
    }

    expect(broken).toEqual([]);
  });

  test("entrypoint src/index.ts dispatches every command referenced from .md docs", async () => {
    // Sanity check: anything we tell users to run via `bun run src/index.ts <cmd>`
    // must be wired into the dispatcher. If a command name appears in commands/*.md
    // but isn't routed by index.ts, users will get an unknown-command/silent-default.
    const indexText = await readFile(join(REPO_ROOT, "src", "index.ts"), "utf8");
    const cmdDir = join(REPO_ROOT, "commands");
    const entries = await readdir(cmdDir);
    const dispatchedTokens = new Set<string>();
    for (const name of entries) {
      if (!name.endsWith(".md")) continue;
      const text = await readFile(join(cmdDir, name), "utf8");
      const matches = text.matchAll(/src\/index\.ts\s+(--?\w[\w-]*)/g);
      for (const m of matches) dispatchedTokens.add(m[1]);
    }

    const missing: string[] = [];
    for (const tok of dispatchedTokens) {
      // `--clear`, `--stop`, `start`, `status`, `send`, `run`...
      const literal = `"${tok}"`;
      if (!indexText.includes(literal)) {
        // `run` is invoked via `claude-hermes run <job-name>` — that path is
        // documented in jobs.md but the dispatcher routes unknowns to start().
        // Skip job-runner pseudo-command which is intentionally handled by
        // start.ts internally rather than the dispatcher.
        if (tok === "run") continue;
        missing.push(tok);
      }
    }
    expect(missing).toEqual([]);
  });

  test("hooks/hooks.json references a script that exists in package.json", async () => {
    const hookText = await readFile(join(REPO_ROOT, "hooks", "hooks.json"), "utf8");
    const hooks = JSON.parse(hookText) as { hooks?: Record<string, string> };
    const pkgText = await readFile(join(REPO_ROOT, "package.json"), "utf8");
    const pkg = JSON.parse(pkgText) as { scripts?: Record<string, string> };
    const scripts = pkg.scripts ?? {};

    for (const [hook, command] of Object.entries(hooks.hooks ?? {})) {
      // commands look like "bun run verify:fast" — extract the script name.
      const m = command.match(/bun run (\S+)/);
      if (!m) continue;
      expect(scripts[m[1]], `hook "${hook}" references missing package.json script "${m[1]}"`).toBeDefined();
    }
  });
});
