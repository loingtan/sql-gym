-- Your progress. Exercise runs are always rolled back; this table is written by the app only.
CREATE SCHEMA app;

CREATE TABLE app.progress (
  item_id      text PRIMARY KEY,           -- exercise id (e.g. perf-03-1) or quiz id (e.g. quiz:ap-02)
  passed_at    timestamptz NOT NULL DEFAULT now(),
  best_ms      double precision,
  best_speedup double precision
);
