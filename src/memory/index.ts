/**
 * Barrel for the memory layer.
 */

export {
  appendCrossSessionMemory,
  readChannelMemory,
  readCrossSessionMemory,
  readIdentity,
  readSoul,
  readUserMemory,
  writeChannelMemory,
  writeUserMemory,
} from "./files";
export { composeSystemPrompt, type ComposeContext } from "./compose";
export { searchSessions, type SessionSearchParams } from "./search";
export {
  extractFacts,
  nudgeAndPersist,
  resetExtractor,
  setExtractor,
  type ExtractedFact,
  type Extractor,
  type NudgeOptions,
  type TranscriptTurn,
} from "./nudge";
export { dispatchAgentMemory, type AgentMemoryOp, type AgentMemoryResult } from "./agent-memory-dispatch";
