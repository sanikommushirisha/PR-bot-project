import type Database from "better-sqlite3";
import type { CreateJobInput, Job, JobStatus } from "../types/index.js";

interface JobRow {
  id: number;
  task_description: string;
  context_note: string | null;
  requesting_user_id: string;
  requesting_username: string | null;
  chat_id: string;
  message_id: string;
  message_thread_id: string | null;
  target_repo: string;
  target_base_branch: string;
  status: JobStatus;
  branch_name: string | null;
  pr_url: string | null;
  error_message: string | null;
  attempts: number;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

function rowToJob(row: JobRow): Job {
  return {
    id: row.id,
    taskDescription: row.task_description,
    contextNote: row.context_note,
    requestingUserId: row.requesting_user_id,
    requestingUsername: row.requesting_username,
    chatId: row.chat_id,
    messageId: row.message_id,
    messageThreadId: row.message_thread_id,
    targetRepo: row.target_repo,
    targetBaseBranch: row.target_base_branch,
    status: row.status,
    branchName: row.branch_name,
    prUrl: row.pr_url,
    errorMessage: row.error_message,
    attempts: row.attempts,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

function createJob(db: Database.Database, input: CreateJobInput): Job {
  const stmt = db.prepare(`
    INSERT INTO jobs (
      task_description, context_note, requesting_user_id, requesting_username,
      chat_id, message_id, message_thread_id, target_repo, target_base_branch
    ) VALUES (
      @taskDescription, @contextNote, @requestingUserId, @requestingUsername,
      @chatId, @messageId, @messageThreadId, @targetRepo, @targetBaseBranch
    )
  `);
  const info = stmt.run({ contextNote: null, messageThreadId: null, ...input });
  return getJobById(db, Number(info.lastInsertRowid))!;
}

function getJobById(db: Database.Database, id: number): Job | undefined {
  const row = db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as
    | JobRow
    | undefined;
  return row ? rowToJob(row) : undefined;
}

/**
 * Atomically claims the oldest pending job by moving it straight to `running`
 * in one UPDATE ... WHERE status = 'pending' statement, so concurrent workers
 * (if ever run) can't double-pick the same job.
 */
function claimNextPendingJob(db: Database.Database): Job | undefined {
  const row = db
    .prepare(
      `
      UPDATE jobs
      SET status = 'running', started_at = datetime('now'), attempts = attempts + 1
      WHERE id = (
        SELECT id FROM jobs WHERE status = 'pending' ORDER BY created_at ASC LIMIT 1
      )
      AND status = 'pending'
      RETURNING *
    `
    )
    .get() as JobRow | undefined;
  return row ? rowToJob(row) : undefined;
}

function markBranch(db: Database.Database, id: number, branchName: string): void {
  db.prepare("UPDATE jobs SET branch_name = ? WHERE id = ?").run(branchName, id);
}

function markCompleted(db: Database.Database, id: number, prUrl: string): void {
  db.prepare(
    "UPDATE jobs SET status = 'completed', pr_url = ?, completed_at = datetime('now') WHERE id = ?"
  ).run(prUrl, id);
}

function markFailed(db: Database.Database, id: number, errorMessage: string): void {
  db.prepare(
    "UPDATE jobs SET status = 'failed', error_message = ?, completed_at = datetime('now') WHERE id = ?"
  ).run(errorMessage, id);
}

const MAX_STUCK_ATTEMPTS = 3;

function toSqliteDatetime(date: Date): string {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

/**
 * Recovers jobs left `running` by a crashed worker. Jobs under the attempt
 * limit go back to `pending`; jobs that have already been stuck-and-requeued
 * too many times are marked `failed` instead, so a job that reliably crashes
 * the worker can't loop forever.
 */
function resetStuckJobs(
  db: Database.Database,
  timeoutMs: number
): { requeued: number; failed: number } {
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
        `Exceeded ${MAX_STUCK_ATTEMPTS} stuck-job recovery attempts (worker likely crashing on this job).`
      );
      failedCount++;
    } else {
      db.prepare(
        "UPDATE jobs SET status = 'pending', started_at = NULL WHERE id = ?"
      ).run(row.id);
      requeued++;
    }
  }

  return { requeued, failed: failedCount };
}

export const Jobs = {
  create: createJob,
  getById: getJobById,
  claimNextPending: claimNextPendingJob,
  markBranch,
  markCompleted,
  markFailed,
  resetStuck: resetStuckJobs,
};
