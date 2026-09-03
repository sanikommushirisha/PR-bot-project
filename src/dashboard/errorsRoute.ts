import type { Request, Response } from "express";
import type Database from "better-sqlite3";
import { ActivityLogs } from "../db/index.js";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** The dashboard's "what broke, and where" panel — recent errors across every job and integration (Claude/GitHub/Linear/system), most recent first. */
export function createErrorsHandler(db: Database.Database) {
  return function handleErrors(req: Request, res: Response): void {
    const limitRaw = Number(req.query.limit);
    const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, MAX_LIMIT) : DEFAULT_LIMIT;

    res.json({ errors: ActivityLogs.listRecentErrors(db, limit) });
  };
}

/** Manual "Clear all" from the errors panel. */
export function createDeleteErrorsHandler(db: Database.Database) {
  return function handleDeleteErrors(_req: Request, res: Response): void {
    const deleted = ActivityLogs.deleteAllErrors(db);
    res.json({ deleted });
  };
}
