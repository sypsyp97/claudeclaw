/**
 * Post-turn "capture candidate skill" completion hook.
 *
 * Wraps `proposeSkillFromTrajectory` + `writeSkill` + `upsertSkill` into a
 * single no-throw entry point that the runner can fire-and-forget after a
 * successful turn. The hook ALWAYS stops at status=`candidate` — promotion to
 * shadow/active is human-review-only and lives elsewhere.
 *
 * Behavior summary:
 *   - settings.captureCandidateSkills=false  → skipped:disabled (no-op)
 *   - trivial trajectory                      → skipped:trivial (no-op)
 *   - existing row at shadow/active/disabled  → skipped:exists  (no-op)
 *   - new or candidate row                    → captured        (write + upsert)
 *   - any thrown error during disk/DB work    → skipped:error   (swallowed)
 */

import { writeSkill } from "../skills/library";
import { getSharedDb } from "../state/shared-db";
import { getSkill, upsertSkill } from "../state/repos/skills";
import { proposeSkillFromTrajectory, type Trajectory, type TrajectoryToolCall } from "./closed-loop";

export interface CompletionHookInput {
  prompt: string;
  reply: string;
  tools?: TrajectoryToolCall[];
  cwd?: string;
}

export type CaptureStatus =
  | "captured"
  | "skipped:disabled"
  | "skipped:trivial"
  | "skipped:exists"
  | "skipped:error";

export interface CompletionHookResult {
  status: CaptureStatus;
  skillName?: string;
  reason?: string;
}

export interface CaptureSettings {
  captureCandidateSkills: boolean;
}

export async function captureCandidateSkill(
  input: CompletionHookInput,
  settings: CaptureSettings
): Promise<CompletionHookResult> {
  if (!settings.captureCandidateSkills) {
    return { status: "skipped:disabled" };
  }

  const trajectory: Trajectory = {
    prompt: input.prompt,
    reply: input.reply,
    tools: input.tools ?? [],
  };

  const candidate = proposeSkillFromTrajectory(trajectory);
  if (!candidate) {
    return { status: "skipped:trivial" };
  }

  try {
    const db = await getSharedDb(input.cwd);
    const existing = getSkill(db, candidate.name);
    if (existing && existing.status !== "candidate") {
      return { status: "skipped:exists", skillName: candidate.name };
    }

    await writeSkill(
      {
        name: candidate.name,
        description: candidate.description,
        skillMd: candidate.body,
      },
      input.cwd
    );
    upsertSkill(db, {
      name: candidate.name,
      path: `.claude/hermes/skills/${candidate.name}`,
      status: "candidate",
    });
    return { status: "captured", skillName: candidate.name };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { status: "skipped:error", skillName: candidate.name, reason };
  }
}
