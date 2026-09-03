import type Database from "better-sqlite3";
import { Jobs } from "../db/index.js";
import type { Job } from "../types/job.js";
import { findPullRequestForBranch, parseRepoSlug, type PullRequestStatus } from "../services/githubService.js";
import { config } from "../config/env.js";

export type LaneKey = "your_move" | "waiting_on_reviewers" | "automated" | "downstream";

export const LANE_ORDER: LaneKey[] = ["your_move", "waiting_on_reviewers", "automated", "downstream"];

export const LANE_META: Record<LaneKey, { label: string; description: string }> = {
  your_move: { label: "Your move", description: "preview the draft, then advance it" },
  waiting_on_reviewers: { label: "Waiting on reviewers", description: "a human reviewer's turn" },
  automated: { label: "Automated", description: "AI coder — no action needed" },
  downstream: { label: "Downstream", description: "merged & awaiting release" },
};

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

export interface DashboardLanes {
  your_move: DashboardCard[];
  waiting_on_reviewers: DashboardCard[];
  automated: DashboardCard[];
  downstream: DashboardCard[];
  generatedAt: string;
}

function cardFromActiveJob(job: Job): DashboardCard {
  const isRunning = job.status === "running";
  return {
    lane: "automated",
    reason: isRunning ? "AI coder drafting" : "queued, waiting for the runner",
    identifier: job.linearIssueIdentifier,
    title: job.linearIssueTitle,
    stage: isRunning ? "In progress" : "Queued",
    prUrl: null,
    prNumber: null,
    timestamp: job.startedAt ?? job.createdAt,
    jobId: isRunning ? job.id : null,
  };
}

function cardFromFailedJob(job: Job): DashboardCard {
  return {
    lane: "your_move",
    reason: job.errorMessage ? `failed: ${job.errorMessage}` : "failed",
    identifier: job.linearIssueIdentifier,
    title: job.linearIssueTitle,
    stage: "Failed",
    prUrl: null,
    prNumber: null,
    timestamp: job.completedAt ?? job.createdAt,
    jobId: null,
  };
}

/** Maps a completed job's live GitHub PR status onto a lane. Returns null for closed-without-merge PRs — resolved, nothing left to act on. */
function cardFromCompletedJob(job: Job, pr: PullRequestStatus): DashboardCard | null {
  const base = {
    identifier: job.linearIssueIdentifier,
    title: job.linearIssueTitle,
    prUrl: pr.url,
    prNumber: pr.number,
    timestamp: pr.updatedAt,
    jobId: null,
  };

  if (pr.merged) {
    return { ...base, lane: "downstream", reason: "merged, awaiting release", stage: "Merged" };
  }
  if (pr.state === "closed") {
    return null;
  }
  if (pr.isDraft) {
    return { ...base, lane: "your_move", reason: "preview the draft, then advance it", stage: "Draft" };
  }
  if (pr.checksState === "failure") {
    return { ...base, lane: "your_move", reason: "a required check is failing", stage: "Checks failing" };
  }
  if (pr.mergeableState === "dirty") {
    return { ...base, lane: "your_move", reason: "merge conflicts need resolving", stage: "Conflicts" };
  }
  if (pr.reviewDecision === "changes_requested") {
    return { ...base, lane: "your_move", reason: "reviewer requested changes", stage: "Changes requested" };
  }
  if (pr.reviewDecision === "approved") {
    return { ...base, lane: "your_move", reason: "approved — ready to merge", stage: "Ready to merge" };
  }
  return { ...base, lane: "waiting_on_reviewers", reason: "awaiting a human reviewer's turn", stage: "In review" };
}

/** Assembles the dashboard from the job queue plus, for every completed job, a live GitHub lookup of its PR's draft/review/check state. */
export async function buildDashboard(db: Database.Database): Promise<DashboardLanes> {
  const lanes: DashboardLanes = {
    your_move: [],
    waiting_on_reviewers: [],
    automated: [],
    downstream: [],
    generatedAt: new Date().toISOString(),
  };

  for (const job of Jobs.listActive(db)) {
    lanes.automated.push(cardFromActiveJob(job));
  }
  for (const job of Jobs.listFailed(db)) {
    lanes.your_move.push(cardFromFailedJob(job));
  }

  const { owner, repo } = parseRepoSlug(config.github.slug);
  const completed = Jobs.listCompletedWithBranch(db);
  const results = await Promise.all(
    completed.map(async (job) => {
      if (!job.branchName) return null;
      try {
        const pr = await findPullRequestForBranch(owner, repo, job.branchName);
        return pr ? cardFromCompletedJob(job, pr) : null;
      } catch (err) {
        console.error(`Dashboard: failed to fetch PR status for job #${job.id} (${job.branchName}):`, err);
        return null;
      }
    })
  );
  for (const card of results) {
    if (card) lanes[card.lane].push(card);
  }

  return lanes;
}
