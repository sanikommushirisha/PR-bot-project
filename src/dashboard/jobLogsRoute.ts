import type { Request, Response } from "express";
import type Database from "better-sqlite3";
import { Jobs, ActivityLogs } from "../db/index.js";

/** Polled by the dashboard's "live activity" modal — returns log entries
 * newer than `after` (a previously-seen id) plus the job's current status,
 * so the frontend knows when to stop polling. Entries persist past job
 * completion (subject to the retention cron / manual delete), so this also
 * works for reviewing a finished job's history. */
export function createJobLogsHandler(db: Database.Database) {
  return function handleJobLogs(req: Request, res: Response): void {
    const jobId = Number(req.params.id);
    if (!Number.isInteger(jobId)) {
      res.status(400).json({ error: "Invalid job id." });
      return;
    }

    const afterRaw = Number(req.query.after);
    const after = Number.isFinite(afterRaw) ? afterRaw : 0;

    const job = Jobs.getById(db, jobId);
    const logs = ActivityLogs.listForJob(db, jobId, after);

    res.json({ status: job?.status ?? "unknown", logs });
  };
}

/** Manual "Clear logs" from the modal — deletes one job's persisted log entries on request. */
export function createDeleteJobLogsHandler(db: Database.Database) {
  return function handleDeleteJobLogs(req: Request, res: Response): void {
    const jobId = Number(req.params.id);
    if (!Number.isInteger(jobId)) {
      res.status(400).json({ error: "Invalid job id." });
      return;
    }

    const deleted = ActivityLogs.deleteForJob(db, jobId);
    res.json({ deleted });
  };
}
