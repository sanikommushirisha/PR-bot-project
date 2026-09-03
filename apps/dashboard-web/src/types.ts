export type LaneKey = "your_move" | "waiting_on_reviewers" | "automated" | "downstream";

export interface DashboardCard {
  lane: LaneKey;
  reason: string;
  identifier: string;
  title: string;
  stage: string;
  prUrl: string | null;
  prNumber: number | null;
  /** SQLite ("YYYY-MM-DD HH:MM:SS", UTC) or ISO timestamp this card's "time in stage" is measured from. */
  timestamp: string;
  /** Set only for a running job — lets the dashboard poll its live activity log. */
  jobId: number | null;
}

export interface JobLogEntry {
  seq: number;
  timestamp: string;
  text: string;
}

export interface JobLogsResponse {
  status: string;
  logs: JobLogEntry[];
}

export interface DashboardLanes {
  your_move: DashboardCard[];
  waiting_on_reviewers: DashboardCard[];
  automated: DashboardCard[];
  downstream: DashboardCard[];
  generatedAt: string;
}

export const LANE_ORDER: LaneKey[] = ["your_move", "waiting_on_reviewers", "automated", "downstream"];

export const LANE_META: Record<LaneKey, { label: string; description: string }> = {
  your_move: { label: "Your move", description: "preview the draft, then advance it" },
  waiting_on_reviewers: { label: "Waiting on reviewers", description: "a human reviewer's turn" },
  automated: { label: "Automated", description: "AI coder — no action needed" },
  downstream: { label: "Downstream", description: "merged & awaiting release" },
};
