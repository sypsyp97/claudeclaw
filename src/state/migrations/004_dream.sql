-- Dream consolidation pass.
-- Adds `digested_at` to `messages` so the nightly compaction can mark which
-- rows are already rolled into a `digests` summary, and adds the `digests`
-- table itself: one row per (session_id, time window) compressed batch.

ALTER TABLE messages ADD COLUMN digested_at TEXT;

CREATE TABLE IF NOT EXISTS digests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  window_start TEXT NOT NULL,
  window_end TEXT NOT NULL,
  summary TEXT NOT NULL,
  source_msg_ids TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_digests_session ON digests(session_id, window_start);
