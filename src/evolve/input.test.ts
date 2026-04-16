import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inboxDir } from "../paths";
import { fromGitHubIssues, type GitHubIssue, readLocalEvolveInbox } from "./input";

const ORIG_CWD = process.cwd();
let tempRoot: string;
let evolveInbox: string;

beforeAll(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "hermes-evolve-input-"));
  process.chdir(tempRoot);
  evolveInbox = join(inboxDir(tempRoot), "evolve");
});

afterAll(async () => {
  process.chdir(ORIG_CWD);
  await rm(tempRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  await rm(evolveInbox, { recursive: true, force: true });
});

async function writeTask(id: string, raw: string): Promise<void> {
  await mkdir(evolveInbox, { recursive: true });
  await writeFile(join(evolveInbox, `${id}.md`), raw, "utf8");
}

describe("readLocalEvolveInbox", () => {
  test("returns [] when the inbox directory does not exist", async () => {
    const tasks = await readLocalEvolveInbox(tempRoot);
    expect(tasks).toEqual([]);
  });

  test("returns [] when the inbox directory is empty", async () => {
    await mkdir(evolveInbox, { recursive: true });
    const tasks = await readLocalEvolveInbox(tempRoot);
    expect(tasks).toEqual([]);
  });

  test("ignores non-markdown files", async () => {
    await mkdir(evolveInbox, { recursive: true });
    await writeFile(join(evolveInbox, "note.txt"), "ignored", "utf8");
    await writeFile(join(evolveInbox, "blob.json"), "{}", "utf8");
    await writeTask("keep", "# keep me\nbody");
    const tasks = await readLocalEvolveInbox(tempRoot);
    expect(tasks.map((t) => t.id)).toEqual(["keep"]);
  });

  test("parses frontmatter fields (votes, source, createdAt) and body title", async () => {
    await writeTask(
      "rich",
      "---\nvotes: 7\nsource: discord\ncreatedAt: 2026-04-10T08:00:00Z\n---\n# Fancy title\nmore body lines\n"
    );
    const tasks = await readLocalEvolveInbox(tempRoot);
    expect(tasks.length).toBe(1);
    const t = tasks[0]!;
    expect(t.id).toBe("rich");
    expect(t.source).toBe("discord");
    expect(t.votes).toBe(7);
    expect(t.createdAt).toBe("2026-04-10T08:00:00Z");
    expect(t.title).toBe("Fancy title");
    expect(t.body).toContain("more body lines");
  });

  test("falls back to defaults when frontmatter is missing", async () => {
    await writeTask("plain", "# just a title\ncontent\n");
    const tasks = await readLocalEvolveInbox(tempRoot);
    expect(tasks.length).toBe(1);
    const t = tasks[0]!;
    expect(t.id).toBe("plain");
    expect(t.source).toBe("local");
    expect(t.votes).toBe(0);
    expect(t.title).toBe("just a title");
    // createdAt should be a valid ISO timestamp (defaulted to now())
    expect(Number.isNaN(Date.parse(t.createdAt))).toBe(false);
  });

  test("strips leading hashes from the derived title", async () => {
    await writeTask("h3", "### triple hash heading\nbody");
    const tasks = await readLocalEvolveInbox(tempRoot);
    expect(tasks[0]?.title).toBe("triple hash heading");
  });

  test("skips leading blank lines when computing the title", async () => {
    await writeTask("blanks", "\n\n\nreal first line here\n");
    const tasks = await readLocalEvolveInbox(tempRoot);
    expect(tasks[0]?.title).toBe("real first line here");
  });

  test("empty files are still surfaced (collector falls back to the filename id)", async () => {
    // The guard changed from `if (!raw)` to `if (raw === null)`. A 0-byte
    // file no longer vanishes silently — it shows up as a zero-vote stub
    // whose title falls back to the filename, the same path as a
    // whitespace-only body.
    await writeTask("empty", "");
    await writeTask("populated", "# populated\nbody");
    const tasks = await readLocalEvolveInbox(tempRoot);
    const ids = tasks.map((t) => t.id).sort();
    expect(ids).toEqual(["empty", "populated"]);
    const empty = tasks.find((t) => t.id === "empty");
    expect(empty?.title).toBe("empty");
    expect(empty?.votes).toBe(0);
  });

  test("falls back to filename id when the body is only whitespace", async () => {
    await writeTask("blank", "   \n  \n");
    const tasks = await readLocalEvolveInbox(tempRoot);
    expect(tasks.length).toBe(1);
    expect(tasks[0]?.title).toBe("blank");
    expect(tasks[0]?.id).toBe("blank");
  });

  test("caps title at 140 characters", async () => {
    const longTitle = "a".repeat(300);
    await writeTask("long", `# ${longTitle}\nbody`);
    const tasks = await readLocalEvolveInbox(tempRoot);
    expect(tasks[0]?.title.length).toBeLessThanOrEqual(140);
  });

  test("handles malformed frontmatter gracefully (no crash, sane defaults)", async () => {
    // missing closing --- => regex won't match, treated as plain body
    await writeTask("bad", "---\nvotes: 5\nsource: discord\nno closing fence\n# after");
    const tasks = await readLocalEvolveInbox(tempRoot);
    expect(tasks.length).toBe(1);
    const t = tasks[0]!;
    expect(t.source).toBe("local");
    expect(t.votes).toBe(0);
    // Title comes from the first non-blank line of the raw body.
    expect(t.title).toContain("---");
  });

  test("ignores frontmatter lines that are not k: v pairs", async () => {
    await writeTask("mixed", "---\nvotes: 2\nnot-a-pair-line\nsource: local\n---\n# fine\n");
    const tasks = await readLocalEvolveInbox(tempRoot);
    expect(tasks[0]?.votes).toBe(2);
    expect(tasks[0]?.source).toBe("local");
  });

  test("non-numeric votes become NaN -> coerced via Number('xx')", async () => {
    await writeTask("weird", "---\nvotes: abc\n---\n# weird\n");
    const tasks = await readLocalEvolveInbox(tempRoot);
    // Number("abc") === NaN; capture the actual behaviour so regressions are visible.
    expect(Number.isNaN(tasks[0]?.votes)).toBe(true);
  });

  test("returns multiple tasks when several markdown files are present", async () => {
    await writeTask("one", "---\nvotes: 1\n---\n# one\n");
    await writeTask("two", "---\nvotes: 2\n---\n# two\n");
    await writeTask("three", "---\nvotes: 3\n---\n# three\n");
    const tasks = await readLocalEvolveInbox(tempRoot);
    expect(tasks.length).toBe(3);
    const ids = tasks.map((t) => t.id).sort();
    expect(ids).toEqual(["one", "three", "two"]);
  });

  test("uses process.cwd() when no cwd argument is provided", async () => {
    await writeTask("implicit", "# implicit cwd\n");
    const tasks = await readLocalEvolveInbox();
    expect(tasks.map((t) => t.id)).toContain("implicit");
  });
});

describe("fromGitHubIssues", () => {
  const labeled = (overrides: Partial<GitHubIssue>): GitHubIssue => ({
    id: 1,
    title: "title",
    body: "body",
    labels: [{ name: "hermes-input" }],
    reactions: { "+1": 0, "-1": 0 },
    created_at: "2026-04-16T00:00:00Z",
    ...overrides,
  });

  test("returns [] when no issues carry the matching label", () => {
    expect(fromGitHubIssues([labeled({ labels: [{ name: "bug" }] })])).toEqual([]);
  });

  test("filters by label name (default 'hermes-input')", () => {
    const issues: GitHubIssue[] = [
      labeled({ id: 1, title: "keep", labels: [{ name: "hermes-input" }] }),
      labeled({ id: 2, title: "skip", labels: [{ name: "other" }] }),
      labeled({ id: 3, title: "keep2", labels: [{ name: "hermes-input" }, { name: "bug" }] }),
    ];
    const tasks = fromGitHubIssues(issues);
    expect(tasks.map((t) => t.title).sort()).toEqual(["keep", "keep2"]);
  });

  test("honours a custom label argument", () => {
    const tasks = fromGitHubIssues(
      [labeled({ id: 1, title: "a", labels: [{ name: "custom-label" }] })],
      "custom-label"
    );
    expect(tasks.length).toBe(1);
    expect(tasks[0]?.id).toBe("gh-1");
  });

  test("prefixes ids with 'gh-' and sets source='github'", () => {
    const tasks = fromGitHubIssues([labeled({ id: 42, title: "x" })]);
    expect(tasks[0]?.id).toBe("gh-42");
    expect(tasks[0]?.source).toBe("github");
  });

  test("computes net votes as (+1) - (-1)", () => {
    const tasks = fromGitHubIssues([
      labeled({ id: 1, reactions: { "+1": 10, "-1": 3 } }),
      labeled({ id: 2, reactions: { "+1": 4 } }),
      labeled({ id: 3, reactions: { "-1": 2 } }),
      labeled({ id: 4, reactions: undefined }),
    ]);
    expect(tasks.find((t) => t.id === "gh-1")?.votes).toBe(7);
    expect(tasks.find((t) => t.id === "gh-2")?.votes).toBe(4);
    expect(tasks.find((t) => t.id === "gh-3")?.votes).toBe(-2);
    expect(tasks.find((t) => t.id === "gh-4")?.votes).toBe(0);
  });

  test("uses empty string when body is missing", () => {
    const tasks = fromGitHubIssues([labeled({ id: 1, body: undefined })]);
    expect(tasks[0]?.body).toBe("");
  });

  test("preserves the issue created_at as-is", () => {
    const tasks = fromGitHubIssues([labeled({ id: 1, created_at: "2022-01-02T03:04:05Z" })]);
    expect(tasks[0]?.createdAt).toBe("2022-01-02T03:04:05Z");
  });
});
