-- Park-style scoring layer.
-- Adds per-message importance + last_access columns so retrieval can blend
-- recency, intrinsic importance, and FTS relevance.
-- importance: 0..10 integer score; default 5 (mid).
-- last_access: ISO-8601 UTC timestamp the row was last surfaced/used; NULL until touched.

ALTER TABLE messages ADD COLUMN importance INTEGER NOT NULL DEFAULT 5;
ALTER TABLE messages ADD COLUMN last_access TEXT;
