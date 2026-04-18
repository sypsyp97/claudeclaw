-- Skill description full-text search.
-- A standalone (non-content-table) FTS5 virtual table indexed by skill name.
-- Skills live on disk under `.claude/hermes/skills/<name>/`, not in a SQL
-- source table, so trigger-based content sync would have nothing to mirror.
-- Instead, `writeSkill` performs explicit DELETE + INSERT into this table on
-- every successful write, which keeps the index in lockstep with disk state.

CREATE VIRTUAL TABLE IF NOT EXISTS skill_descriptions_fts USING fts5(
  name UNINDEXED,
  description
);
