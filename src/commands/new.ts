import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { hermesDir, jobsDir, promptsDir } from "../paths";

const VALID_KINDS = ["job", "skill", "prompt"] as const;
type Kind = (typeof VALID_KINDS)[number];

interface ParsedFlags {
  schedule?: string;
  prompt?: string;
  force: boolean;
}

function parseFlags(rest: string[]): ParsedFlags {
  const flags: ParsedFlags = { force: false };
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (token === "--force") {
      flags.force = true;
    } else if (token === "--schedule" && i + 1 < rest.length) {
      flags.schedule = rest[++i];
    } else if (token === "--prompt" && i + 1 < rest.length) {
      flags.prompt = rest[++i];
    }
  }
  return flags;
}

function isValidName(name: string): boolean {
  if (!name) return false;
  if (name.startsWith(".")) return false;
  if (name.includes("/") || name.includes("\\")) return false;
  if (name.includes("..")) return false;
  return true;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

async function writeScaffold(path: string, body: string, force: boolean): Promise<void> {
  if (existsSync(path) && !force) {
    fail(`Error: ${path} already exists. Use --force to overwrite.`);
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, body, "utf8");
  console.log(`Created ${path}`);
}

async function scaffoldJob(name: string, flags: ParsedFlags): Promise<void> {
  const schedule = flags.schedule ?? "0 * * * *";
  const prompt = flags.prompt ?? "TODO: describe what this job should do.";
  const body = `---\nschedule: "${schedule}"\n---\n${prompt}\n`;
  const path = join(jobsDir(), `${name}.md`);
  await writeScaffold(path, body, flags.force);
}

async function scaffoldSkill(name: string, flags: ParsedFlags): Promise<void> {
  const skillDir = join(hermesDir(), "skills", name);
  if (existsSync(skillDir) && !flags.force) {
    fail(`Error: ${skillDir} already exists. Use --force to overwrite.`);
  }
  if (existsSync(skillDir) && flags.force) {
    await rm(skillDir, { recursive: true, force: true });
  }
  await mkdir(skillDir, { recursive: true });
  const path = join(skillDir, "SKILL.md");
  const body = `---\nname: ${name}\ndescription: TODO: describe what this skill does and when to trigger it.\n---\n\nTODO: fill in skill instructions.\n`;
  await writeFile(path, body, "utf8");
  console.log(`Created ${path}`);
}

async function scaffoldPrompt(name: string, flags: ParsedFlags): Promise<void> {
  const body = "TODO: write the prompt body.\n";
  const path = join(promptsDir(), `${name}.md`);
  await writeScaffold(path, body, flags.force);
}

export async function newCmd(args: string[]): Promise<void> {
  const kind = args[0];
  if (!kind) {
    fail("usage: hermes new <job|skill|prompt> <name> [--schedule <cron>] [--prompt <text>] [--force]");
  }
  if (!VALID_KINDS.includes(kind as Kind)) {
    fail(`Error: unknown kind "${kind}". Valid kinds: ${VALID_KINDS.join(", ")}.`);
  }
  const name = args[1];
  if (!name) {
    fail(`usage: hermes new ${kind} <name> [flags]`);
  }
  if (!isValidName(name)) {
    fail(`Error: invalid name "${name}". Names cannot be empty, start with ".", or contain "/", "\\", or "..".`);
  }

  const flags = parseFlags(args.slice(2));

  if (kind === "job") {
    await scaffoldJob(name, flags);
  } else if (kind === "skill") {
    await scaffoldSkill(name, flags);
  } else {
    await scaffoldPrompt(name, flags);
  }
  process.exit(0);
}
