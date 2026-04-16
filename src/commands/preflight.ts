import { preflight as runPreflight } from "../preflight";

/**
 * Explicit entry point for plugin preflight. Clones the third-party plugin
 * repos and runs `bun install` / `npm install`, then writes the plugin set
 * into the project's `.claude/settings.json`. This is a network-touching
 * operation that executes arbitrary upstream code, so it is never run as part
 * of daemon start — the user has to type it.
 */
export function preflight(_args: string[] = []): void {
  runPreflight(process.cwd());
}
