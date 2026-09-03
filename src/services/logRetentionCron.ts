import type Database from "better-sqlite3";
import { ActivityLogs } from "../db/activityLogs.js";

const RETENTION_DAYS = 2;
const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000; // every 6 hours

function sweep(db: Database.Database): void {
  const deleted = ActivityLogs.deleteOlderThanDays(db, RETENTION_DAYS);
  if (deleted > 0) {
    console.log(`Log retention cron: purged ${deleted} activity log row(s) older than ${RETENTION_DAYS} days.`);
  }
}

/**
 * Runs a retention sweep immediately at startup, then on a fixed interval
 * for the life of the process, so activity_logs never accumulates more than
 * ~2 days of history regardless of how many jobs run. `unref()` so this
 * background timer never keeps the process alive on its own.
 */
export function startLogRetentionCron(db: Database.Database): void {
  sweep(db);
  setInterval(() => sweep(db), SWEEP_INTERVAL_MS).unref();
}
