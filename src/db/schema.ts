export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  linear_issue_id TEXT NOT NULL,
  linear_issue_identifier TEXT NOT NULL,
  linear_issue_title TEXT NOT NULL,
  linear_issue_description TEXT,
  channel_id TEXT,
  thread_ts TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  -- Linear's own scale: 0 = No priority, 1 = Urgent, 2 = High, 3 = Medium, 4 = Low.
  priority INTEGER NOT NULL DEFAULT 0,
  -- The branch this job's changes were pushed to. The next queued job clones
  -- from here instead of the base branch, chaining branch -> branch -> branch
  -- so every task builds on the latest (still-unmerged) work.
  branch_name TEXT,
  error_message TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_jobs_status_priority_created_at ON jobs (status, priority, created_at);

-- Unique only among non-terminal rows: prevents a re-triggered/duplicated
-- webhook delivery for the same issue from enqueueing a second concurrent
-- run, while still allowing the same issue to be queued again later (a
-- deliberate retry) once its previous run has finished.
CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_active_issue
  ON jobs (linear_issue_id)
  WHERE status IN ('pending', 'running');

-- Single-row table (id is always 1) tracking the batch-review checkpoint:
-- how far the automated review has looked, and whatever it last flagged
-- and is still awaiting a /fix decision on.
CREATE TABLE IF NOT EXISTS review_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_reviewed_branch TEXT,
  pending_flag_findings TEXT,
  pending_flag_thread_ts TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

/**
 * Columns added after a table's original creation. `CREATE TABLE IF NOT
 * EXISTS` above is a no-op against an already-existing table, so an existing
 * database needs these added explicitly via ALTER TABLE.
 */
export const COLUMN_MIGRATIONS: { table: string; column: string; ddl: string }[] = [
  { table: "jobs", column: "branch_name", ddl: "ALTER TABLE jobs ADD COLUMN branch_name TEXT" },
  {
    table: "review_state",
    column: "pending_flag_thread_ts",
    ddl: "ALTER TABLE review_state ADD COLUMN pending_flag_thread_ts TEXT",
  },
];
