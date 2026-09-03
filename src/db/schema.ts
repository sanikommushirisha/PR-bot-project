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

-- Correlates a Slack thread back to the Linear issue it registered, from the
-- moment /task creates the issue — before any \`jobs\` row exists for it (that
-- only appears once the issue is moved to the trigger state). This is what
-- lets a later message in the same thread (e.g. an image) find its way to
-- the right Linear issue.
CREATE TABLE IF NOT EXISTS slack_threads (
  channel_id TEXT NOT NULL,
  thread_ts TEXT NOT NULL,
  linear_issue_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (channel_id, thread_ts)
);

-- Records both routine agent activity ('info') and integration failures
-- ('error') tagged by which integration produced them (claude/github/linear,
-- or 'system' for anything else, e.g. an uncaught bug). job_id is nullable
-- because some errors happen outside any job (e.g. resolving the Linear team
-- at startup). This is the single source for both the dashboard's
-- per-job "live activity" view and its cross-job "integration errors" view.
CREATE TABLE IF NOT EXISTS activity_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER,
  source TEXT NOT NULL CHECK (source IN ('claude', 'github', 'linear', 'system')),
  level TEXT NOT NULL DEFAULT 'info' CHECK (level IN ('info', 'error')),
  message TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

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
 * Indexes run separately, after `SCHEMA_SQL` and `COLUMN_MIGRATIONS` — some
 * reference columns (e.g. `priority`) that only exist on a pre-existing
 * database once its column migrations have run.
 */
export const INDEX_SQL = `
CREATE INDEX IF NOT EXISTS idx_jobs_status_priority_created_at ON jobs (status, priority, created_at);

-- Unique only among non-terminal rows: prevents a re-triggered/duplicated
-- webhook delivery for the same issue from enqueueing a second concurrent
-- run, while still allowing the same issue to be queued again later (a
-- deliberate retry) once its previous run has finished.
CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_active_issue
  ON jobs (linear_issue_id)
  WHERE status IN ('pending', 'running');

-- Serves the per-job "live activity" poll (job_id, id) and the retention
-- cron's sweep by age (created_at). The cross-job error view filters
-- WHERE level = 'error' on top of idx_activity_logs_created_at, which is
-- selective enough (errors are rare) not to need its own index.
CREATE INDEX IF NOT EXISTS idx_activity_logs_job_id ON activity_logs (job_id, id);
CREATE INDEX IF NOT EXISTS idx_activity_logs_created_at ON activity_logs (created_at);
`;

/**
 * Columns added after a table's original creation. `CREATE TABLE IF NOT
 * EXISTS` above is a no-op against an already-existing table, so an existing
 * database needs these added explicitly via ALTER TABLE.
 */
export const COLUMN_MIGRATIONS: { table: string; column: string; ddl: string }[] = [
  {
    table: "jobs",
    column: "priority",
    ddl: "ALTER TABLE jobs ADD COLUMN priority INTEGER NOT NULL DEFAULT 0",
  },
  { table: "jobs", column: "branch_name", ddl: "ALTER TABLE jobs ADD COLUMN branch_name TEXT" },
  {
    table: "review_state",
    column: "pending_flag_thread_ts",
    ddl: "ALTER TABLE review_state ADD COLUMN pending_flag_thread_ts TEXT",
  },
];
