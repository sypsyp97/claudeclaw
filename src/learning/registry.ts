/**
 * Learning-aware registry — wraps the pure skill discovery with DB-backed
 * promotion state. `listActiveSkills()` returns only skills marked active;
 * discovery is still the source for path/description.
 */

import type { Database } from "../state/db";
import { listSkills as listDbSkills } from "../state/repos/skills";
import { discoverSkills, type DiscoveryRoots, type SkillInfo } from "../skills/discovery";

export { discoverSkills, extractDescription } from "../skills/discovery";
export { listSkills, resolveSkillPrompt } from "../skills/registry";
export type { SkillInfo, SkillSource } from "../skills/discovery";

export async function listActiveSkills(db: Database, roots?: DiscoveryRoots): Promise<SkillInfo[]> {
  const filesystem = await discoverSkills(roots);
  const activeNames = new Set(listDbSkills(db, "active").map((row) => row.name));
  return filesystem.filter((s) => activeNames.has(s.name));
}

export async function listCandidateSkills(db: Database, roots?: DiscoveryRoots): Promise<SkillInfo[]> {
  const filesystem = await discoverSkills(roots);
  const names = new Set(listDbSkills(db, "candidate").map((row) => row.name));
  const shadow = new Set(listDbSkills(db, "shadow").map((row) => row.name));
  return filesystem.filter((s) => names.has(s.name) || shadow.has(s.name));
}
