/**
 * Voyager-style closed learning loop primitive.
 *
 * Two halves:
 *   - `proposeSkillFromTrajectory` — turns a (prompt, reply, tools) trace into
 *     a candidate skill manifest that passes `validateSkillManifest`. Returns
 *     null for trivial trajectories so the caller can move on without writing
 *     junk into the skills repo.
 *   - `promoteIfVerified` — validates the candidate, runs the verify gate
 *     once, and writes the row at `shadow` on success or leaves it at
 *     `candidate` on failure. Already-active skills are never demoted by
 *     this path.
 *
 * This module is the primitive only — wiring it into runner.ts or any cron
 * is a separate concern (W9).
 */

import { join } from "node:path";

import { validateSkillManifest } from "../skills/validate";
import { getSkill, setStatus, upsertSkill } from "../state/repos/skills";
import type { Database } from "../state/db";

export interface TrajectoryToolCall {
  name: string;
  ok: boolean;
}

export interface Trajectory {
  prompt: string;
  reply: string;
  tools: TrajectoryToolCall[];
}

export interface SkillCandidate {
  name: string;
  description: string;
  body: string;
}

export interface PromoteOptions {
  runVerify: () => Promise<boolean>;
  skillsRoot?: string;
}

export interface PromoteResult {
  ok: boolean;
  reason?: string;
  finalStatus: "candidate" | "shadow" | "active" | "disabled" | "absent";
}

const NAME_MAX = 64;
const DESCRIPTION_MAX = 1024;
// Internal soft cap: leaves headroom under the 1024-char hard cap so
// templating overhead never trips rule-5.
const DESCRIPTION_SOFT_CAP = 600;

// Mirror of validate.ts' allow-list. Kept private so the impl can pick a
// stable opener without a runtime import dance.
const IMPERATIVE_VERBS = [
  "Use",
  "Create",
  "Build",
  "Run",
  "Handle",
  "Apply",
  "Scan",
  "Generate",
  "Review",
  "Refactor",
  "Fix",
  "Add",
  "Remove",
  "Convert",
  "Parse",
  "Validate",
  "Search",
  "List",
  "Show",
  "Start",
  "Stop",
  "Debug",
  "Test",
  "Deploy",
  "Monitor",
  "Schedule",
] as const;

// Map of common prompt-leading words to a sensible imperative verb. Anything
// not in the map falls back to "Use" which is always safe.
const VERB_HINTS: Record<string, (typeof IMPERATIVE_VERBS)[number]> = {
  run: "Run",
  execute: "Run",
  create: "Create",
  make: "Create",
  build: "Build",
  compile: "Build",
  refactor: "Refactor",
  rewrite: "Refactor",
  fix: "Fix",
  repair: "Fix",
  add: "Add",
  remove: "Remove",
  delete: "Remove",
  scan: "Scan",
  search: "Search",
  find: "Search",
  parse: "Parse",
  validate: "Validate",
  check: "Validate",
  generate: "Generate",
  review: "Review",
  list: "List",
  show: "Show",
  display: "Show",
  start: "Start",
  stop: "Stop",
  debug: "Debug",
  test: "Test",
  deploy: "Deploy",
  monitor: "Monitor",
  schedule: "Schedule",
  apply: "Apply",
  convert: "Convert",
  handle: "Handle",
  use: "Use",
};

function slugify(input: string): string {
  const lowered = input.toLowerCase();
  // Replace any run of non-[a-z0-9] with a single hyphen, then trim hyphens.
  const slug = lowered.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (slug.length === 0) return "";
  return slug.length > NAME_MAX ? slug.slice(0, NAME_MAX).replace(/-+$/g, "") : slug;
}

function shortHash(input: string): string {
  // Tiny non-cryptographic hash — only needed for the empty-slug fallback.
  let h = 5381;
  for (let i = 0; i < input.length; i += 1) {
    h = ((h << 5) + h + input.charCodeAt(i)) >>> 0;
  }
  return h.toString(36).slice(0, 8);
}

function pickImperative(prompt: string): (typeof IMPERATIVE_VERBS)[number] {
  const firstWord = prompt.trim().toLowerCase().split(/\s+/)[0] ?? "";
  return VERB_HINTS[firstWord] ?? "Use";
}

function summarizePrompt(prompt: string, maxLen: number): string {
  // Single-line, whitespace-collapsed, length-capped summary. We avoid
  // mid-word truncation when easy.
  const oneLine = prompt.replace(/\s+/g, " ").trim();
  if (oneLine.length <= maxLen) return oneLine;
  const sliced = oneLine.slice(0, maxLen);
  const lastSpace = sliced.lastIndexOf(" ");
  return (lastSpace > maxLen * 0.6 ? sliced.slice(0, lastSpace) : sliced).trim();
}

function buildDescription(prompt: string): string {
  const verb = pickImperative(prompt);
  // Reserve room for the templating prefix/suffix so the final string fits
  // under the soft cap.
  const prefix = verb === "Use" ? "Use this skill when " : `${verb} when `;
  const suffix = ".";
  const room = DESCRIPTION_SOFT_CAP - prefix.length - suffix.length;
  const summary = summarizePrompt(prompt, Math.max(40, room));
  let description = `${prefix}${summary}${suffix}`;
  if (description.length > DESCRIPTION_MAX) {
    description = description.slice(0, DESCRIPTION_MAX - 1) + ".";
  }
  return description;
}

function buildBody(name: string, prompt: string, reply: string, tools: TrajectoryToolCall[]): string {
  const title = `# ${name}`;
  const summary = summarizePrompt(prompt, 200);
  const replyEcho = summarizePrompt(reply, 200);
  const toolLines = tools.length
    ? tools.map((t) => `- ${t.name} (${t.ok ? "ok" : "fail"})`).join("\n")
    : "- (no tools recorded)";
  const body = [
    title,
    "",
    `Captured from a successful trajectory: ${summary}`,
    "",
    "## Tools",
    toolLines,
    "",
    "## Example reply",
    replyEcho,
    "",
  ].join("\n");
  // Clamp to validator's 500-line cap with a healthy margin.
  const lines = body.split("\n");
  if (lines.length > 480) {
    return `${lines.slice(0, 480).join("\n")}\n`;
  }
  return body;
}

export function proposeSkillFromTrajectory(trajectory: Trajectory): SkillCandidate | null {
  const prompt = trajectory.prompt?.trim() ?? "";
  const reply = trajectory.reply?.trim() ?? "";
  const tools = trajectory.tools ?? [];

  if (prompt.length === 0) return null;

  // "Too thin": no tools AND a short reply (≤ 5 words). The trajectory has
  // not done enough work to be worth distilling into a reusable skill.
  const replyWordCount = reply.length === 0 ? 0 : reply.split(/\s+/).length;
  if (tools.length === 0 && replyWordCount <= 5) return null;

  let name = slugify(prompt);
  if (name.length === 0) {
    name = `skill-${shortHash(prompt)}`;
  }

  let description = buildDescription(prompt);
  let body = buildBody(name, prompt, reply, tools);

  let validation = validateSkillManifest({ name, description, body });
  if (!validation.ok) {
    // One retry attempt — re-slug name harder, shorten description.
    name = slugify(name) || `skill-${shortHash(prompt)}`;
    description = `Use this skill when ${summarizePrompt(prompt, 200)}.`;
    body = buildBody(name, prompt, reply, tools);
    validation = validateSkillManifest({ name, description, body });
    if (!validation.ok) return null;
  }

  return { name, description, body };
}

export async function promoteIfVerified(
  db: Database,
  candidate: SkillCandidate,
  opts: PromoteOptions
): Promise<PromoteResult> {
  const validation = validateSkillManifest(candidate);
  if (!validation.ok) {
    return {
      ok: false,
      reason: "invalid-candidate",
      finalStatus: "absent",
    };
  }

  try {
    const existing = getSkill(db, candidate.name);
    if (existing && existing.status === "active") {
      return {
        ok: true,
        reason: "already-promoted",
        finalStatus: "active",
      };
    }

    const skillPath = opts.skillsRoot ? join(opts.skillsRoot, candidate.name) : candidate.name;
    upsertSkill(db, {
      name: candidate.name,
      path: skillPath,
      status: "candidate",
    });

    let verified: boolean;
    try {
      verified = await opts.runVerify();
    } catch {
      return {
        ok: false,
        reason: "verify-failed",
        finalStatus: "candidate",
      };
    }

    if (!verified) {
      return {
        ok: false,
        reason: "verify-failed",
        finalStatus: "candidate",
      };
    }

    setStatus(db, candidate.name, "shadow");
    return {
      ok: true,
      reason: "promoted",
      finalStatus: "shadow",
    };
  } catch {
    return {
      ok: false,
      reason: "db-error",
      finalStatus: "absent",
    };
  }
}
