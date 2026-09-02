import type Database from "better-sqlite3";
import type { EnqueueJobInput, Job, JobStatus } from "../types/job.js";

interface JobRow {
  id: number;
  linear_issue_id: string;
  linear_issue_identifier: string;
  linear_issue_title: string;
  linear_issue_description: string | null;
  channel_id: string | null;
  thread_ts: string | null;
  status: JobStatus;
  priority: number;
  branch_name: string | null;
  error_message: string | null;
  attempts: number;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

function rowToJob(row: JobRow): Job {
  return {
    id: row.id,
    linearIssueId: row.linear_issue_id,
    linearIssueIdentifier: row.linear_issue_identifier,
    linearIssueTitle: row.linear_issue_title,
    linearIssueDescription: row.linear_issue_description,
    channelId: row.channel_id,
    threadTs: row.thread_ts,
    status: row.status,
    priority: row.priority,
    branchName: row.branch_name,
    errorMessage: row.error_message,
    attempts: row.attempts,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

/**
 * Enqueues a job, or returns the already-active one for this issue if it's
 * currently pending/running (the partial unique index on linear_issue_id
 * makes this atomic — a redelivered or duplicate webhook can't enqueue a
 * second concurrent run for the same issue). `created` is false when an
 * existing active job was returned instead of a new one.
 */
function enqueueJob(db: Database.Database, input: EnqueueJobInput): { job: Job; created: boolean } {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO jobs (
      linear_issue_id, linear_issue_identifier, linear_issue_title,
      linear_issue_description, channel_id, thread_ts
    ) VALUES (
      @linearIssueId, @linearIssueIdentifier, @linearIssueTitle,
      @linearIssueDescription, @channelId, @threadTs
    )
  `);
  const info = stmt.run(input);
  const job = getActiveByIssueId(db, input.linearIssueId)!;
  return { job, created: info.changes > 0 };
}

function getActiveByIssueId(db: Database.Database, linearIssueId: string): Job | undefined {
  const row = db
    .prepare("SELECT * FROM jobs WHERE linear_issue_id = ? AND status IN ('pending', 'running')")
    .get(linearIssueId) as JobRow | undefined;
  return row ? rowToJob(row) : undefined;
}

function getById(db: Database.Database, id: number): Job | undefined {
  const row = db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as JobRow | undefined;
  return row ? rowToJob(row) : undefined;
}

/** Looks up the job that produced a given branch — used to correlate a GitHub PR's head ref back to its originating Linear issue/Slack thread. */
function getByBranchName(db: Database.Database, branchName: string): Job | undefined {
  const row = db.prepare("SELECT * FROM jobs WHERE branch_name = ?").get(branchName) as JobRow | undefined;
  return row ? rowToJob(row) : undefined;
}

/**
 * Atomically claims the pending job with the best priority (1=Urgent ..
 * 4=Low first; 0/no-priority sorts last), oldest first within the same
 * priority — a single UPDATE ... WHERE status = 'pending' statement, so the
 * runner's serialized loop can never double-claim a row.
 */
function claimNextPending(db: Database.Database): Job | undefined {
  const row = db
    .prepare(
      `
      UPDATE jobs
      SET status = 'running', started_at = datetime('now'), attempts = attempts + 1
      WHERE id = (
        SELECT id FROM jobs
        WHERE status = 'pending'
        ORDER BY (CASE WHEN priority = 0 THEN 999 ELSE priority END) ASC, created_at ASC
        LIMIT 1
      )
      AND status = 'pending'
      RETURNING *
    `
    )
    .get() as JobRow | undefined;
  return row ? rowToJob(row) : undefined;
}

function listActive(db: Database.Database): Job[] {
  const rows = db
    .prepare(
      `SELECT * FROM jobs WHERE status IN ('pending', 'running')
       ORDER BY (CASE WHEN priority = 0 THEN 999 ELSE priority END) ASC, created_at ASC`
    )
    .all() as JobRow[];
  return rows.map(rowToJob);
}

/** Completed jobs with a PR-bearing branch, most recent first — the candidate set for GitHub PR status lookups. */
function listCompletedWithBranch(db: Database.Database, limit = 50): Job[] {
  const rows = db
    .prepare(
      "SELECT * FROM jobs WHERE status = 'completed' AND branch_name IS NOT NULL ORDER BY completed_at DESC LIMIT ?"
    )
    .all(limit) as JobRow[];
  return rows.map(rowToJob);
}

/** Recently failed jobs — surfaced on the dashboard as needing a retry/dismiss decision. */
function listFailed(db: Database.Database, limit = 20): Job[] {
  const rows = db
    .prepare("SELECT * FROM jobs WHERE status = 'failed' ORDER BY completed_at DESC LIMIT ?")
    .all(limit) as JobRow[];
  return rows.map(rowToJob);
}

function markCompleted(db: Database.Database, id: number, branchName: string): void {
  db.prepare(
    "UPDATE jobs SET status = 'completed', branch_name = ?, completed_at = datetime('now') WHERE id = ?"
  ).run(branchName, id);
}

/**
 * The branch the next queued job should clone from — the most recently
 * completed job's branch, or undefined if none has completed yet (meaning
 * the next job should start from the repo's actual base branch).
 */
function getLastCompletedBranch(db: Database.Database): string | undefined {
  const row = db
    .prepare(
      "SELECT branch_name FROM jobs WHERE status = 'completed' AND branch_name IS NOT NULL ORDER BY completed_at DESC, id DESC LIMIT 1"
    )
    .get() as { branch_name: string } | undefined;
  return row?.branch_name;
}

function markFailed(db: Database.Database, id: number, errorMessage: string): void {
  db.prepare(
    "UPDATE jobs SET status = 'failed', error_message = ?, completed_at = datetime('now') WHERE id = ?"
  ).run(errorMessage, id);
}

/** Updates priority only while the job is still pending — a running/finished job's priority no longer matters for scheduling. */
function setPriorityIfPending(db: Database.Database, linearIssueId: string, priority: number): boolean {
  const info = db
    .prepare("UPDATE jobs SET priority = ? WHERE linear_issue_id = ? AND status = 'pending'")
    .run(priority, linearIssueId);
  return info.changes > 0;
}

const MAX_STUCK_ATTEMPTS = 3;

function toSqliteDatetime(date: Date): string {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

/**
 * Recovers jobs left `running` by a crashed process. Jobs under the attempt
 * limit go back to `pending`; jobs that have already been stuck-and-requeued
 * too many times are marked `failed` instead, so an issue that reliably
 * crashes the process can't loop forever.
 */
function resetStuckJobs(db: Database.Database, timeoutMs: number): { requeued: number; failed: number } {
  const cutoff = toSqliteDatetime(new Date(Date.now() - timeoutMs));
  const stuck = db
    .prepare("SELECT * FROM jobs WHERE status = 'running' AND started_at <= ?")
    .all(cutoff) as JobRow[];

  let requeued = 0;
  let failedCount = 0;

  for (const row of stuck) {
    if (row.attempts >= MAX_STUCK_ATTEMPTS) {
      markFailed(
        db,
        row.id,
        `Exceeded ${MAX_STUCK_ATTEMPTS} stuck-job recovery attempts (process likely crashing on this job).`
      );
      failedCount++;
    } else {
      db.prepare("UPDATE jobs SET status = 'pending', started_at = NULL WHERE id = ?").run(row.id);
      requeued++;
    }
  }

  return { requeued, failed: failedCount };
}

export const Jobs = {
  enqueue: enqueueJob,
  getActiveByIssueId,
  getById,
  getByBranchName,
  claimNextPending,
  listActive,
  listCompletedWithBranch,
  listFailed,
  getLastCompletedBranch,
  markCompleted,
  markFailed,
  setPriorityIfPending,
  resetStuck: resetStuckJobs,
};
