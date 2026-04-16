/**
 * Barrel for the evolve loop. Importers take this surface from here so
 * internal reorganisation (e.g. splitting the executor into multiple policies)
 * doesn't ripple out.
 */

export { commitChanges, revertAll, runVerify, type GateRunners, type VerifyResult } from "./gate";
export { executeSelfEdit, type ExecuteOptions, type ExecuteResult } from "./executor";
export { recordEvent, journalFile, type EvolveEvent, type EvolveEventKind } from "./journal";
export {
  evolveOnce,
  type EvolveIterationResult,
  type EvolveTask,
  type LoopHooks,
  type Outcome,
} from "./loop";
