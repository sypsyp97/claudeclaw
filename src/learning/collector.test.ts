import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { applyMigrations, closeDb, type Database, eventsRepo, openDb } from "../state";
import { finishCollect, startCollect } from "./collector";

let db: Database;

beforeAll(async () => {
  db = openDb({ path: ":memory:" });
  await applyMigrations(db);
});

afterAll(() => {
  closeDb(db);
});

beforeEach(() => {
  // Child rows (skill_runs) reference sessions via FK with ON DELETE SET NULL;
  // wipe skill_runs first to keep the sweep deterministic.
  db.exec("DELETE FROM learn_events");
  db.exec("DELETE FROM skill_runs");
  db.exec("DELETE FROM sessions");
});

describe("startCollect", () => {
  test("inserts a skill_runs row and returns the new run id", () => {
    const runId = startCollect(db, {
      skillName: "ping",
      version: 1,
      shadow: true,
    });
    expect(runId).toBeGreaterThan(0);

    const row = db
      .query<{ skill_name: string; version: number; session_id: number | null }, [number]>(
        "SELECT skill_name, version, session_id FROM skill_runs WHERE id = ?"
      )
      .get(runId);
    expect(row?.skill_name).toBe("ping");
    expect(row?.version).toBe(1);
    expect(row?.session_id).toBeNull();
  });

  test("emits a skill.shadow.start event when shadow=true", () => {
    const runId = startCollect(db, {
      skillName: "s",
      version: 1,
      shadow: true,
    });
    const events = eventsRepo.listEvents<{ runId: number; skillName: string }>(db, {
      kindPrefix: "skill.shadow.start",
    });
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("skill.shadow.start");
    expect(events[0].payload.runId).toBe(runId);
    expect(events[0].payload.skillName).toBe("s");
  });

  test("emits a skill.active.start event when shadow=false", () => {
    startCollect(db, {
      skillName: "a",
      version: 2,
      shadow: false,
    });
    const shadow = eventsRepo.listEvents(db, { kindPrefix: "skill.shadow.start" });
    const active = eventsRepo.listEvents(db, { kindPrefix: "skill.active.start" });
    expect(shadow).toHaveLength(0);
    expect(active).toHaveLength(1);
  });

  test("persists sessionId when provided (requires a real sessions row due to FK)", () => {
    // skill_runs.session_id has a FK to sessions(id) — seed one row so the
    // reference is satisfied, then assert round-trip.
    const now = new Date().toISOString();
    const result = db
      .prepare(
        `INSERT INTO sessions (key, scope, source, workspace, created_at, last_used_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run("test-key", "per-user", "cli", "/tmp/ws", now, now);
    const sessionId = Number(result.lastInsertRowid);

    const runId = startCollect(db, {
      skillName: "with-session",
      version: 1,
      sessionId,
      shadow: true,
    });
    const row = db
      .query<{ session_id: number | null }, [number]>("SELECT session_id FROM skill_runs WHERE id = ?")
      .get(runId);
    expect(row?.session_id).toBe(sessionId);
  });

  test("serialises toolsUsed JSON when provided", () => {
    const runId = startCollect(db, {
      skillName: "with-tools",
      version: 1,
      toolsUsed: ["Read", "Edit"],
      shadow: true,
    });
    const row = db
      .query<{ tools_used_json: string | null }, [number]>(
        "SELECT tools_used_json FROM skill_runs WHERE id = ?"
      )
      .get(runId);
    expect(row?.tools_used_json).toBe(JSON.stringify(["Read", "Edit"]));
  });
});

describe("finishCollect", () => {
  test("updates ended_at + success on the target run", () => {
    const runId = startCollect(db, {
      skillName: "done",
      version: 1,
      shadow: true,
    });
    finishCollect(db, {
      runId,
      skillName: "done",
      success: true,
      turnsSaved: 2.5,
      shadow: true,
    });

    const row = db
      .query<{ success: number | null; turns_saved: number | null; ended_at: string | null }, [number]>(
        "SELECT success, turns_saved, ended_at FROM skill_runs WHERE id = ?"
      )
      .get(runId);
    expect(row?.success).toBe(1);
    expect(row?.turns_saved).toBe(2.5);
    expect(row?.ended_at).not.toBeNull();
  });

  test("emits skill.shadow.finish or skill.active.finish depending on shadow flag", () => {
    const shadowId = startCollect(db, { skillName: "s", version: 1, shadow: true });
    finishCollect(db, { runId: shadowId, skillName: "s", success: true, shadow: true });

    const activeId = startCollect(db, { skillName: "a", version: 1, shadow: false });
    finishCollect(db, { runId: activeId, skillName: "a", success: true, shadow: false });

    expect(eventsRepo.listEvents(db, { kindPrefix: "skill.shadow.finish" })).toHaveLength(1);
    expect(eventsRepo.listEvents(db, { kindPrefix: "skill.active.finish" })).toHaveLength(1);
  });

  test("success=false is recorded as 0 in skill_runs and propagated to event payload", () => {
    const runId = startCollect(db, { skillName: "failure", version: 1, shadow: true });
    finishCollect(db, { runId, skillName: "failure", success: false, shadow: true });

    const row = db
      .query<{ success: number | null }, [number]>("SELECT success FROM skill_runs WHERE id = ?")
      .get(runId);
    expect(row?.success).toBe(0);

    const event = eventsRepo.listEvents<{ success: boolean }>(db, {
      kindPrefix: "skill.shadow.finish",
    })[0];
    expect(event.payload.success).toBe(false);
  });

  test("turnsSaved omitted → stored as null in DB, null in event payload", () => {
    const runId = startCollect(db, { skillName: "no-turns", version: 1, shadow: true });
    finishCollect(db, { runId, skillName: "no-turns", success: true, shadow: true });

    const row = db
      .query<{ turns_saved: number | null }, [number]>("SELECT turns_saved FROM skill_runs WHERE id = ?")
      .get(runId);
    expect(row?.turns_saved).toBeNull();

    const event = eventsRepo.listEvents<{ turnsSaved: number | null }>(db, {
      kindPrefix: "skill.shadow.finish",
    })[0];
    expect(event.payload.turnsSaved).toBeNull();
  });

  test("double-finish is rejected: row stays at first values, error event recorded", () => {
    // The collector now guards against double-finish. The DB row keeps the
    // values from the first call; the second call records a
    // `skill.collect.error` event with reason `double-finish` and does NOT
    // emit a second `skill.shadow.finish`.
    const runId = startCollect(db, { skillName: "double", version: 1, shadow: true });
    finishCollect(db, { runId, skillName: "double", success: true, turnsSaved: 1, shadow: true });
    finishCollect(db, { runId, skillName: "double", success: false, turnsSaved: 5, shadow: true });

    const row = db
      .query<{ success: number | null; turns_saved: number | null }, [number]>(
        "SELECT success, turns_saved FROM skill_runs WHERE id = ?"
      )
      .get(runId);
    expect(row?.success).toBe(1); // first call won
    expect(row?.turns_saved).toBe(1);

    const finishEvents = eventsRepo.listEvents(db, { kindPrefix: "skill.shadow.finish" });
    expect(finishEvents).toHaveLength(1);
    const errorEvents = eventsRepo.listEvents<{ reason: string; runId: number }>(db, {
      kindPrefix: "skill.collect.error",
    });
    expect(errorEvents).toHaveLength(1);
    expect(errorEvents[0].payload.reason).toBe("double-finish");
    expect(errorEvents[0].payload.runId).toBe(runId);
  });

  test("finishing a non-existent run id does not throw and records an error event", () => {
    expect(() => {
      finishCollect(db, {
        runId: 999_999_999,
        skillName: "ghost",
        success: true,
        shadow: true,
      });
    }).not.toThrow();
    // No phantom finish event — the collector now cross-checks existence and
    // records a structured error event instead.
    const finishEvents = eventsRepo.listEvents(db, { kindPrefix: "skill.shadow.finish" });
    expect(finishEvents).toHaveLength(0);
    const errorEvents = eventsRepo.listEvents<{ reason: string; runId: number }>(db, {
      kindPrefix: "skill.collect.error",
    });
    expect(errorEvents).toHaveLength(1);
    expect(errorEvents[0].payload.reason).toBe("finish-on-missing-run");
    expect(errorEvents[0].payload.runId).toBe(999_999_999);
  });

  test("userFeedback persists when supplied", () => {
    const runId = startCollect(db, { skillName: "fb", version: 1, shadow: true });
    finishCollect(db, {
      runId,
      skillName: "fb",
      success: true,
      userFeedback: "worked great",
      shadow: true,
    });
    const row = db
      .query<{ user_feedback: string | null }, [number]>("SELECT user_feedback FROM skill_runs WHERE id = ?")
      .get(runId);
    expect(row?.user_feedback).toBe("worked great");
  });
});
