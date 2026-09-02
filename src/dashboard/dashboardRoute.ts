import type { Request, Response } from "express";
import type Database from "better-sqlite3";
import { buildDashboard } from "./dashboardService.js";

export function createDashboardHandler(db: Database.Database) {
  return async function handleDashboard(_req: Request, res: Response): Promise<void> {
    try {
      const lanes = await buildDashboard(db);
      res.json(lanes);
    } catch (err) {
      console.error("Dashboard build failed:", err);
      res.status(500).json({ error: "Failed to build the dashboard — check server logs." });
    }
  };
}
