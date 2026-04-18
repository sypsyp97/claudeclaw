export interface SkillManifestInput {
  name: string;
  description: string;
  body: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

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

const NAME_MAX = 64;
const DESCRIPTION_MAX = 1024;
const BODY_MAX_LINES = 500;
const KEBAB_CASE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const ASCII_ONLY = /^[\x00-\x7F]*$/;

export function validateSkillManifest(input: SkillManifestInput): ValidationResult {
  const errors: string[] = [];
  const { name, description, body } = input;

  if (name.length > NAME_MAX) {
    errors.push(`name is too long: ${name.length} chars (must be ≤ 64 chars)`);
  }

  if (!ASCII_ONLY.test(name)) {
    errors.push("name must be ASCII-only (no emoji or unicode characters)");
  }

  if (!KEBAB_CASE.test(name)) {
    errors.push(
      "name must be kebab-case (lowercase letters, digits, and single hyphens; no leading, trailing, or consecutive hyphens)",
    );
  }

  const trimmedDescription = description.trim();
  if (trimmedDescription.length === 0) {
    errors.push("description must be non-empty after trimming whitespace");
  } else {
    const firstToken = trimmedDescription.split(/\s+/)[0] ?? "";
    const startsWithImperative = IMPERATIVE_VERBS.some((verb) => firstToken === verb);
    if (!startsWithImperative) {
      errors.push(
        `description must start with an imperative verb from: ${IMPERATIVE_VERBS.join(", ")}`,
      );
    }
  }

  if (description.length > DESCRIPTION_MAX) {
    errors.push(
      `description is too long: ${description.length} chars (must be ≤ 1024 chars)`,
    );
  }

  const lineCount = body.split("\n").length;
  if (lineCount > BODY_MAX_LINES) {
    errors.push(`body is too long: ${lineCount} lines (must be ≤ 500 lines)`);
  }

  return { ok: errors.length === 0, errors };
}
