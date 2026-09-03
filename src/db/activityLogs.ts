import type Database from "better-sqlite3";

export type ActivitySource = "claude" | "github" | "linear" | "system";
export type ActivityLevel = "info" | "error";

export interface ActivityLogEntry {
  id: number;
  jobId: number | null;
  source: ActivitySource;
  level: ActivityLevel;
  message: string;
  createdAt: string;
}

export interface IntegrationErrorEntry extends ActivityLogEntry {
  jobIdentifier: string | null;
}

interface ActivityLogRow {
  id: number;
  job_id: number | null;
  source: ActivitySource;
  level: ActivityLevel;
  message: string;
  created_at: string;
}

function rowToEntry(row: ActivityLogRow): ActivityLogEntry {
  return {
    id: row.id,
    jobId: row.job_id,
    source: row.source,
    level: row.level,
    message: row.message,
    createdAt: row.created_at,
  };
}

// A single chatty/long-running agent session could otherwise write an
// unbounded number of 'info' rows — cap each job to its most recent N and
// drop the rest on every insert. 'error' rows are exempt: they're rare and
// always worth keeping until the retention cron or a manual delete removes
// them, regardless of how much 'info' churn happened around them.
const MAX_INFO_ROWS_PER_JOB = 500;

function insert(
  db: Database.Database,
  entry: { jobId: number | null; source: ActivitySource; level?: ActivityLevel; message: string }
): void {
  const level = entry.level ?? "info";
  db.prepare("INSERT INTO activity_logs (job_id, source, level, message) VALUES (?, ?, ?, ?)").run(
    entry.jobId,
    entry.source,
    level,
    entry.message
  );

  if (level === "info" && entry.jobId != null) {
    db.prepare(
      `DELETE FROM activity_logs
       WHERE job_id = ? AND level = 'info'
       AND id NOT IN (
         SELECT id FROM activity_logs WHERE job_id = ? AND level = 'info' ORDER BY id DESC LIMIT ?
       )`
    ).run(entry.jobId, entry.jobId, MAX_INFO_ROWS_PER_JOB);
  }
}

/** Every log entry for a job newer than `afterId` — the dashboard's live-activity poll cursor. */
function listForJob(db: Database.Database, jobId: number, afterId = 0): ActivityLogEntry[] {
  const rows = db
    .prepare("SELECT * FROM activity_logs WHERE job_id = ? AND id > ? ORDER BY id ASC")
    .all(jobId, afterId) as ActivityLogRow[];
  return rows.map(rowToEntry);
}

/** Recent errors across every integration and job, most recent first — the dashboard's "what broke, and where" view. */
function listRecentErrors(db: Database.Database, limit = 50): IntegrationErrorEntry[] {
  const rows = db
    .prepare(
      `SELECT activity_logs.*, jobs.linear_issue_identifier AS job_identifier
       FROM activity_logs
       LEFT JOIN jobs ON jobs.id = activity_logs.job_id
       WHERE activity_logs.level = 'error'
       ORDER BY activity_logs.id DESC
       LIMIT ?`
    )
    .all(limit) as (ActivityLogRow & { job_identifier: string | null })[];
  return rows.map((row) => ({ ...rowToEntry(row), jobIdentifier: row.job_identifier }));
}

function deleteForJob(db: Database.Database, jobId: number): number {
  return db.prepare("DELETE FROM activity_logs WHERE job_id = ?").run(jobId).changes;
}

function deleteAllErrors(db: Database.Database): number {
  return db.prepare("DELETE FROM activity_logs WHERE level = 'error'").run().changes;
}

/** Used by the retention cron — purges anything older than `days`, info and error alike. */
function deleteOlderThanDays(db: Database.Database, days: number): number {
  return db.prepare("DELETE FROM activity_logs WHERE created_at < datetime('now', ?)").run(`-${days} days`).changes;
}

export const ActivityLogs = {
  insert,
  listForJob,
  listRecentErrors,
  deleteForJob,
  deleteAllErrors,
  deleteOlderThanDays,
};
