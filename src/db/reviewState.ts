import type Database from "better-sqlite3";

export interface ReviewState {
  lastReviewedBranch: string | null;
  pendingFlagFindings: string | null;
  pendingFlagThreadTs: string | null;
}

interface ReviewStateRow {
  last_reviewed_branch: string | null;
  pending_flag_findings: string | null;
  pending_flag_thread_ts: string | null;
}

function getReviewState(db: Database.Database): ReviewState {
  const row = db
    .prepare("SELECT last_reviewed_branch, pending_flag_findings, pending_flag_thread_ts FROM review_state WHERE id = 1")
    .get() as ReviewStateRow | undefined;

  return {
    lastReviewedBranch: row?.last_reviewed_branch ?? null,
    pendingFlagFindings: row?.pending_flag_findings ?? null,
    pendingFlagThreadTs: row?.pending_flag_thread_ts ?? null,
  };
}

function setLastReviewedBranch(db: Database.Database, branch: string): void {
  db.prepare(
    `
    INSERT INTO review_state (id, last_reviewed_branch, updated_at)
    VALUES (1, ?, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET last_reviewed_branch = excluded.last_reviewed_branch, updated_at = excluded.updated_at
  `
  ).run(branch);
}

function setPendingFlag(db: Database.Database, findings: string, threadTs: string | null): void {
  db.prepare(
    `
    INSERT INTO review_state (id, pending_flag_findings, pending_flag_thread_ts, updated_at)
    VALUES (1, ?, ?, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      pending_flag_findings = excluded.pending_flag_findings,
      pending_flag_thread_ts = excluded.pending_flag_thread_ts,
      updated_at = excluded.updated_at
  `
  ).run(findings, threadTs);
}

function clearPendingFlag(db: Database.Database): void {
  db.prepare(
    "UPDATE review_state SET pending_flag_findings = NULL, pending_flag_thread_ts = NULL, updated_at = datetime('now') WHERE id = 1"
  ).run();
}

export const ReviewState = {
  get: getReviewState,
  setLastReviewedBranch,
  setPendingFlag,
  clearPendingFlag,
};
