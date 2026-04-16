/**
 * Input aggregator for the evolve loop. Pulls pending tasks from local
 * inbox markdown files + (optional) GitHub issues. Every source produces
 * the same `PendingTask` shape so the planner can sort uniformly.
 *
 * Local inbox layout (created on demand):
 *   .claude/hermes/inbox/evolve/<slug>.md
 *
 * with optional YAML-ish frontmatter:
 *   ---
 *   votes: 3
 *   source: discord
 *   createdAt: 2026-04-16T12:00:00Z
 *   ---
 *   <body>
 */

import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join } from "node:path";
import { inboxDir } from "../paths";

export interface PendingTask {
  id: string;
  source: string;
  title: string;
  body: string;
  votes: number;
  createdAt: string;
}

export async function readLocalEvolveInbox(cwd?: string): Promise<PendingTask[]> {
  const dir = join(inboxDir(cwd), "evolve");
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir).catch(() => []);
  const tasks: PendingTask[] = [];
  for (const name of entries) {
    if (extname(name) !== ".md") continue;
    const full = join(dir, name);
    // `null` means the read failed; an empty string means the file is empty
    // — only the former should be skipped silently. An empty task file is a
    // user error worth surfacing as a zero-vote stub instead of vanishing.
    const raw = await readFile(full, "utf8").catch(() => null);
    if (raw === null) continue;
    tasks.push(parseMarkdownTask(name, raw));
  }
  return tasks;
}

export interface GitHubIssue {
  id: number;
  title: string;
  body?: string;
  labels: Array<{ name: string }>;
  reactions?: { "+1"?: number; "-1"?: number };
  created_at: string;
}

export function fromGitHubIssues(issues: GitHubIssue[], label = "hermes-input"): PendingTask[] {
  return issues
    .filter((issue) => issue.labels.some((l) => l.name === label))
    .map((issue) => ({
      id: `gh-${issue.id}`,
      source: "github",
      title: issue.title,
      body: issue.body ?? "",
      votes: (issue.reactions?.["+1"] ?? 0) - (issue.reactions?.["-1"] ?? 0),
      createdAt: issue.created_at,
    }));
}

function parseMarkdownTask(filename: string, raw: string): PendingTask {
  const id = filename.replace(/\.md$/, "");
  const frontmatter = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  const meta: Record<string, string> = {};
  let body = raw;
  if (frontmatter) {
    for (const line of frontmatter[1].split("\n")) {
      const kv = line.match(/^(\w+):\s*(.+)$/);
      if (kv) meta[kv[1]] = kv[2].trim();
    }
    body = frontmatter[2];
  }
  const titleLine = body.split("\n").find((l) => l.trim().length > 0) ?? id;
  return {
    id,
    source: meta.source ?? "local",
    title: titleLine.replace(/^#+\s*/, "").slice(0, 140),
    body: body.trim(),
    votes: Number(meta.votes ?? "0"),
    createdAt: meta.createdAt ?? new Date().toISOString(),
  };
}
