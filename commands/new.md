---
description: "Scaffold a new hermes job, skill, or prompt from a template. Triggers: new job, new skill, new prompt, scaffold, create template, boilerplate, job template, skill template, prompt template, stub, starter file"
---

Scaffold a new hermes artifact (job, skill, or prompt) with sensible defaults.

1. Use **AskUserQuestion** to pick the kind:
   - Header: "Kind"
   - Options: "job (cron-scheduled prompt)", "skill (SKILL.md with frontmatter)", "prompt (reusable prompt file)"

2. Ask for a name:
   - Header: "Name"
   - Options: suggest 2 contextual names based on the project.
   - Name must be non-empty, cannot start with `.`, and cannot contain `/`, `\`, or `..`.

3. Run the scaffolder:
   ```bash
   bun run ${CLAUDE_PLUGIN_ROOT}/src/index.ts new <kind> <name>
   ```
   For jobs you may also pass `--schedule "<cron>"` and `--prompt "<text>"`. Pass `--force` if the file already exists and the user confirmed overwrite.

4. Report the `Created <path>` line back to the user and remind them the daemon hot-reloads jobs every 30 seconds (no restart needed).
