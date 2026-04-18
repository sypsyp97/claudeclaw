/**
 * JSON-in / JSON-out dispatcher around the 6-op agent memory protocol in
 * `./agent-memory`. Matches the shape of Anthropic's `memory_20250818`
 * tool-use calls so a model's structured output can be routed straight into
 * the underlying filesystem operations.
 *
 * Invariants:
 * - The dispatcher NEVER throws. Any error thrown by the underlying op (path
 *   validation, missing file, create-over-existing, etc.) is caught and
 *   surfaced as `{ ok: false, error: <message> }`.
 * - Unknown op names return `{ ok: false, error: "unknown op: <name>" }`.
 * - Successful `view` returns `{ ok: true, result: ViewResult }`.
 * - Successful mutators return `{ ok: true }` (no result field).
 */

import * as agentMemory from "./agent-memory";

export type AgentMemoryOp =
  | { op: "view"; path: string }
  | { op: "create"; path: string; content: string }
  | { op: "str_replace"; path: string; old_str: string; new_str: string }
  | { op: "insert"; path: string; line: number; content: string }
  | { op: "delete"; path: string }
  | { op: "rename"; old_path: string; new_path: string };

export interface AgentMemoryResult {
  ok: boolean;
  result?: unknown;
  error?: string;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export async function dispatchAgentMemory(call: AgentMemoryOp, cwd?: string): Promise<AgentMemoryResult> {
  try {
    switch (call.op) {
      case "view": {
        const result = await agentMemory.view(call.path, cwd);
        return { ok: true, result };
      }
      case "create": {
        await agentMemory.create(call.path, call.content, cwd);
        return { ok: true };
      }
      case "str_replace": {
        await agentMemory.strReplace(call.path, call.old_str, call.new_str, cwd);
        return { ok: true };
      }
      case "insert": {
        await agentMemory.insert(call.path, call.line, call.content, cwd);
        return { ok: true };
      }
      case "delete": {
        await agentMemory.del(call.path, cwd);
        return { ok: true };
      }
      case "rename": {
        await agentMemory.rename(call.old_path, call.new_path, cwd);
        return { ok: true };
      }
      default: {
        // Anything that doesn't match the 6 known ops. The `as` cast is
        // needed because, in the well-typed world, `call` has type `never`
        // in this branch — but at runtime a model can easily hand us an
        // off-contract op string, and the dispatcher's job is to reject it
        // cleanly rather than throw.
        const unknownOp = (call as { op?: unknown }).op;
        return { ok: false, error: `unknown op: ${String(unknownOp)}` };
      }
    }
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}
