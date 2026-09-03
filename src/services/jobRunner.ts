import type Database from "better-sqlite3";
import { Jobs, ActivityLogs } from "../db/index.js";
import type { Job } from "../types/job.js";
import { fetchFullIssueContext, moveIssueToStateType } from "./linearService.js";
import { postSlackMessage } from "./slackService.js";
import { runAgentTask } from "./claudeService.js";
import {
  cloneRepo,
  createBranch,
  hasChanges,
  commitAll,
  pushBranch,
  cleanupClone,
  createDraftPullRequest,
  buildBranchName,
  parseRepoSlug,
} from "./githubService.js";
import { config } from "../config/env.js";
import { runBatchReview } from "./reviewService.js";
import { IntegrationError, integrationSourceOf } from "../errors/integrationError.js";

// Guards the queue-draining loop so only one job ever runs at a time in this
// process, regardless of how many webhook deliveries arrive concurrently —
// the check-and-set here is synchronous, so there's no race within Node's
// single-threaded event loop.
let isRunnerActive = false;

/** Starts draining the queue if nothing else is already doing so. Safe to call from anywhere, any number of times — a no-op while a run is already in progress. */
export function kickRunner(db: Database.Database): void {
  if (isRunnerActive) return;
  isRunnerActive = true;

  (async () => {
    try {
      let processedAny = false;
      while (true) {
        const job = Jobs.claimNextPending(db);
        if (!job) break;
        await processJob(db, job);
        processedAny = true;
      }
      // Runs once the queue is genuinely empty — not on every single job,
      // only after the whole batch that was in flight has finished.
      if (processedAny) {
        await runBatchReview(db).catch((err) => {
          console.error("Batch review failed:", err);
        });
      }
    } finally {
      isRunnerActive = false;
    }
  })().catch((err) => {
    console.error("Unhandled error in job runner loop:", err);
    isRunnerActive = false;
  });
}

async function processJob(db: Database.Database, job: Job): Promise<void> {
  console.log(`Claimed job #${job.id} (${job.linearIssueIdentifier}): ${job.linearIssueTitle}`);

  let cloneDir: string | undefined;
  try {
    const issueContext = await fetchFullIssueContext(job.linearIssueId);
    const { owner, repo } = parseRepoSlug(config.github.slug);
    const branchName = buildBranchName(issueContext.title, issueContext.identifier);

    // Every task branches straight off the current base branch, independent
    // of any other task's branch — no chaining. Each one gets its own draft
    // PR immediately; merging and any resulting conflict resolution is
    // entirely manual, by whoever reviews the PR.
    const { git, dir } = await cloneRepo({
      owner,
      repo,
      branch: config.github.baseBranch,
      workDirName: issueContext.identifier,
    });
    cloneDir = dir;

    await createBranch(git, branchName);

    const agentResult = await runAgentTask(dir, issueContext, job.id, db);
    if (!agentResult.success) {
      throw new IntegrationError("claude", `Agent session did not complete successfully: ${agentResult.summary}`);
    }

    if (!(await hasChanges(git))) {
      throw new Error("Agent finished without making any file changes.");
    }

    await commitAll(
      git,
      `Automated change via slack-linear-claude-agent for ${issueContext.identifier}\n\n${issueContext.title}`
    );
    await pushBranch(git, branchName);

    const prTitle = issueContext.title.length > 72 ? `${issueContext.title.slice(0, 69)}...` : issueContext.title;
    const pr = await createDraftPullRequest({
      owner,
      repo,
      base: config.github.baseBranch,
      head: branchName,
      title: `[agent] ${prTitle}`,
      body: [
        `## ${issueContext.identifier}: ${issueContext.title}`,
        "",
        issueContext.description ?? "",
        "",
        "## Agent summary",
        "",
        agentResult.summary,
        "",
        "---",
        "_Opened automatically by slack-linear-claude-agent. This is a draft; review before merging._",
      ].join("\n"),
    });

    await moveIssueToStateType(job.linearIssueId, "started", ["In Review"]);
    Jobs.markCompleted(db, job.id, branchName);

    if (job.channelId && job.threadTs) {
      await postSlackMessage(
        job.channelId,
        `✅ ${issueContext.identifier} done — draft PR opened:\n${pr.url}`,
        job.threadTs
      );
    }

    console.log(`Finished job #${job.id} (${job.linearIssueIdentifier}) — PR #${pr.number}: ${pr.url}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const source = integrationSourceOf(err);
    console.error(`Job #${job.id} (${job.linearIssueIdentifier}) failed [${source}]:`, err);

    try {
      Jobs.markFailed(db, job.id, message);
    } catch (markFailedErr) {
      // If this write itself fails (e.g. disk full), the job stays "running"
      // rather than "failed" — resetStuckJobs recovers it on next startup.
      // What must not happen is this error escaping processJob: that would
      // kill kickRunner's while-loop and stall every other queued job too.
      console.error(`Failed to record job #${job.id} as failed:`, markFailedErr);
    }
    ActivityLogs.insert(db, { jobId: job.id, source, level: "error", message });

    await moveIssueToStateType(job.linearIssueId, "canceled", ["Failed"]).catch((moveErr) => {
      ActivityLogs.insert(db, {
        jobId: job.id,
        source: "linear",
        level: "error",
        message: `Could not move issue to its failed state: ${moveErr instanceof Error ? moveErr.message : String(moveErr)}`,
      });
    });

    if (job.channelId && job.threadTs) {
      await postSlackMessage(
        job.channelId,
        `❌ ${job.linearIssueIdentifier} failed: ${message}`,
        job.threadTs
      ).catch(() => {});
    }
  } finally {
    if (cloneDir) {
      await cleanupClone(cloneDir).catch((cleanupErr) => {
        console.error(`Failed to clean up clone dir for job #${job.id}:`, cleanupErr);
      });
    }
  }
}
