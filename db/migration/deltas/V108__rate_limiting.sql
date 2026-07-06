-- =============================================================================
-- Migration 008: DB-backed rate limiting buckets
-- =============================================================================

-- Sliding-window counters. Rows are cleaned up by the check function (rows
-- older than 2 windows are pruned on each check call, amortised cleanup).
CREATE TABLE IF NOT EXISTS rate_limit_buckets (
  key           text        NOT NULL,
  window_start  timestamptz NOT NULL,
  count         int         NOT NULL DEFAULT 1,
  PRIMARY KEY (key, window_start)
);

CREATE INDEX IF NOT EXISTS rate_limit_buckets_window_idx
  ON rate_limit_buckets(window_start);
