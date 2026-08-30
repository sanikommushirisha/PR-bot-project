export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_description TEXT NOT NULL,
  context_note TEXT,
  requesting_user_id TEXT NOT NULL,
  requesting_username TEXT,
  chat_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  message_thread_id TEXT,
  target_repo TEXT NOT NULL,
  target_base_branch TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  branch_name TEXT,
  pr_url TEXT,
  error_message TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_jobs_status_created_at ON jobs (status, created_at);
`;
