/**
 * Agent-writable memory protocol matching Anthropic's `memory_20250818` tool
 * shape. All operations are scoped to:
 *
 *   <cwd>/memory/agent/
 *
 * Six ops: view, create, strReplace, insert, del, rename. Every path goes
 * through `resolveAgentPath`, which is the single gatekeeper that validates
 * the requested path lives strictly inside the agent root and returns the
 * resolved absolute path. Anything that escapes (absolute paths, `..`
 * traversals, the empty string for write ops, `\`-style Windows traversals)
 * throws an Error whose message contains both `"path"` and `"invalid"`.
 *
 * The agent root is created on demand by writing ops; reads tolerate a
 * missing root by returning an empty directory listing.
 */

import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename as fsRename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const AGENT_SUBPATH = ["memory", "agent"];

export interface ViewDirResult {
  kind: "dir";
  entries: Array<{ name: string; kind: "file" | "dir" }>;
}

export interface ViewFileResult {
  kind: "file";
  content: string;
}

export type ViewResult = ViewDirResult | ViewFileResult;

function agentRootFor(cwd?: string): string {
  return resolve(cwd ?? process.cwd(), ...AGENT_SUBPATH);
}

function invalidPath(input: string): Error {
  return new Error(`invalid path: ${JSON.stringify(input)}`);
}

/**
 * Validate `input` and return the absolute path it maps to inside the agent
 * root. Throws for anything that escapes the root or smells like an absolute
 * / traversal path.
 *
 * `allowRoot` controls whether the empty string / "." (i.e. "the agent root
 * itself") is acceptable — read ops allow it, write ops do not.
 */
function resolveAgentPath(input: string, cwd: string | undefined, options: { allowRoot: boolean }): string {
  if (typeof input !== "string") throw invalidPath(String(input));

  const root = agentRootFor(cwd);

  // Empty string / "." are only valid when caller explicitly allows them
  // (view of the root). For write ops they are nonsense.
  if (input === "" || input === ".") {
    if (options.allowRoot) return root;
    throw invalidPath(input);
  }

  // Reject obvious absolute paths up-front. We check both POSIX and Windows
  // forms because `node:path.isAbsolute` on Windows would happily resolve
  // `/abs` relative to the current drive, which would still escape the
  // agent root once `relative()` runs — but doing the early check makes the
  // intent and the error message explicit.
  if (isAbsolute(input) || input.startsWith("/") || input.startsWith("\\")) {
    throw invalidPath(input);
  }

  // Reject Windows drive-letter prefixes like `C:foo`.
  if (/^[a-zA-Z]:/.test(input)) throw invalidPath(input);

  // Normalise both `/` and `\` style separators to system separators so
  // resolve() treats `..\foo` as a traversal on POSIX too.
  const normalised = input.replace(/[\\/]+/g, sep);

  const resolved = resolve(root, normalised);
  const rel = relative(root, resolved);

  // Empty `rel` means "the root itself". Allowed only if allowRoot.
  if (rel === "") {
    if (options.allowRoot) return root;
    throw invalidPath(input);
  }

  // Anything that climbs out of the root, or that resolves to an absolute
  // path on a different drive, is rejected.
  if (rel.startsWith("..") || isAbsolute(rel)) throw invalidPath(input);

  // Per-segment double-check: even after resolve(), reject if any segment
  // is `..` (defence in depth — resolve() should have collapsed these, but
  // a stray segment would mean we mis-normalised).
  for (const seg of rel.split(/[\\/]/)) {
    if (seg === "..") throw invalidPath(input);
  }

  return resolved;
}

// ---------------------------------------------------------------------------
// view
// ---------------------------------------------------------------------------

export async function view(path: string, cwd?: string): Promise<ViewResult> {
  const target = resolveAgentPath(path, cwd, { allowRoot: true });
  const root = agentRootFor(cwd);

  // The agent root may not exist yet — listing it returns empty rather than
  // throwing. Any other missing path is a hard error.
  if (!existsSync(target)) {
    if (target === root) return { kind: "dir", entries: [] };
    throw new Error(`path not found: ${path}`);
  }

  const st = await stat(target);
  if (st.isDirectory()) {
    const dirents = await readdir(target, { withFileTypes: true });
    const entries = dirents
      .map((d) => ({
        name: d.name,
        kind: d.isDirectory() ? ("dir" as const) : ("file" as const),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return { kind: "dir", entries };
  }

  const content = await readFile(target, "utf8");
  return { kind: "file", content };
}

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

export async function create(path: string, content: string, cwd?: string): Promise<void> {
  const target = resolveAgentPath(path, cwd, { allowRoot: false });
  if (existsSync(target)) {
    throw new Error(`file already exists: ${path}`);
  }
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content, "utf8");
}

// ---------------------------------------------------------------------------
// strReplace
// ---------------------------------------------------------------------------

export async function strReplace(
  path: string,
  oldString: string,
  newString: string,
  cwd?: string
): Promise<void> {
  const target = resolveAgentPath(path, cwd, { allowRoot: false });
  if (!existsSync(target)) {
    throw new Error(`file not found: ${path}`);
  }
  const original = await readFile(target, "utf8");

  // Uniqueness check: count by `split(oldString).length - 1`. This works
  // even if oldString contains regex metacharacters (we deliberately do not
  // use a regex). An empty oldString would explode this count, so guard it.
  if (oldString.length === 0) {
    throw new Error(`strReplace: oldString must not be empty (path=${path})`);
  }
  const occurrences = original.split(oldString).length - 1;
  if (occurrences === 0) {
    throw new Error(`strReplace: oldString not found in ${path}`);
  }
  if (occurrences > 1) {
    throw new Error(
      `strReplace: oldString matches ${occurrences} times in ${path}, must be unique (multiple matches)`
    );
  }

  // String.replace with a string pattern replaces only the first match,
  // which is what we want now that we've verified uniqueness.
  const next = original.replace(oldString, newString);
  await writeFile(target, next, "utf8");
}

// ---------------------------------------------------------------------------
// insert
// ---------------------------------------------------------------------------

export async function insert(path: string, afterLine: number, content: string, cwd?: string): Promise<void> {
  const target = resolveAgentPath(path, cwd, { allowRoot: false });
  if (!existsSync(target)) {
    throw new Error(`file not found: ${path}`);
  }
  const original = await readFile(target, "utf8");
  const lines = original.split("\n");

  // afterLine is 1-indexed. 0 prepends. Out-of-range appends.
  let insertAt: number;
  if (afterLine <= 0) insertAt = 0;
  else if (afterLine >= lines.length) insertAt = lines.length;
  else insertAt = afterLine;

  lines.splice(insertAt, 0, content);
  await writeFile(target, lines.join("\n"), "utf8");
}

// ---------------------------------------------------------------------------
// del
// ---------------------------------------------------------------------------

export async function del(path: string, cwd?: string): Promise<void> {
  const target = resolveAgentPath(path, cwd, { allowRoot: false });
  // Missing path is a no-op. `rm` with `force: true` swallows ENOENT.
  await rm(target, { force: true, recursive: true });
}

// ---------------------------------------------------------------------------
// rename
// ---------------------------------------------------------------------------

export async function rename(oldPath: string, newPath: string, cwd?: string): Promise<void> {
  const src = resolveAgentPath(oldPath, cwd, { allowRoot: false });
  const dst = resolveAgentPath(newPath, cwd, { allowRoot: false });
  if (!existsSync(src)) {
    throw new Error(`rename: source not found: ${oldPath}`);
  }
  if (existsSync(dst)) {
    throw new Error(`rename: destination already exists: ${newPath}`);
  }
  await mkdir(dirname(dst), { recursive: true });
  await fsRename(src, dst);
}
