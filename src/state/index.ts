/**
 * Barrel re-export for the state engine. Import from here, not from the
 * individual repo files; keeps the daemon's call sites stable as the schema
 * evolves.
 */

export { openDb, closeDb, type Database } from "./db";
export { applyMigrations } from "./bootstrap";
export { importLegacyJson } from "./import-json";
export { bootstrapState } from "./bootstrap-state";
export { getSharedDb, resetSharedDbCache } from "./shared-db";

export * as sessionsRepo from "./repos/sessions";
export * as messagesRepo from "./repos/messages";
export * as policiesRepo from "./repos/policies";
export * as memoryRepo from "./repos/memory";
export * as skillsRepo from "./repos/skills";
export * as skillRunsRepo from "./repos/skillRuns";
export * as jobsRepo from "./repos/jobs";
export * as eventsRepo from "./repos/events";
