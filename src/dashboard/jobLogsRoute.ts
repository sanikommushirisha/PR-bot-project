import type { Request, Response } from "express";
import type Database from "better-sqlite3";
import { Jobs } from "../db/index.js";
import { AgentLogs } from "../services/agentLogService.js";

/** Polled by the dashboard's "live activity" modal — returns log entries
 * newer than `after` (a previously-seen seq number) plus the job's current
 * status, so the frontend knows when to stop polling. */
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
    const logs = AgentLogs.getSince(jobId, after);

    res.json({ status: job?.status ?? "unknown", logs });
  };
}
