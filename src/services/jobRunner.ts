import type Database from "better-sqlite3";
import { Jobs } from "../db/index.js";
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
  buildBranchName,
  buildCompareUrl,
  parseRepoSlug,
} from "./githubService.js";
import { config } from "../config/env.js";
import { runBatchReview } from "./reviewService.js";

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

  // Chain onto the last completed job's branch if one exists, otherwise
  // start fresh from the repo's actual base branch. No PR is opened per
  // task — a human opens one manually from whatever the current chain tip
  // is, whenever they're ready to review.
  const cloneFrom = Jobs.getLastCompletedBranch(db) ?? config.github.baseBranch;

  let cloneDir: string | undefined;
  try {
    const issueContext = await fetchFullIssueContext(job.linearIssueId);
    const { owner, repo } = parseRepoSlug(config.github.slug);
    const branchName = buildBranchName(issueContext.title, issueContext.identifier);

    console.log(`Job #${job.id}: cloning from "${cloneFrom}", building branch "${branchName}".`);

    const { git, dir } = await cloneRepo({
      owner,
      repo,
      baseBranch: cloneFrom,
      issueIdentifier: issueContext.identifier,
    });
    cloneDir = dir;

    await createBranch(git, branchName);

    const agentResult = await runAgentTask(dir, issueContext);
    if (!agentResult.success) {
      throw new Error(`Agent session did not complete successfully: ${agentResult.summary}`);
    }

    if (!(await hasChanges(git))) {
      throw new Error("Agent finished without making any file changes.");
    }

    await commitAll(
      git,
      `Automated change via slack-linear-claude-agent for ${issueContext.identifier}\n\n${issueContext.title}`
    );
    await pushBranch(git, branchName);

    await moveIssueToStateType(job.linearIssueId, "started", ["In Review"]);
    Jobs.markCompleted(db, job.id, branchName);

    if (job.channelId && job.threadTs) {
      const compareUrl = buildCompareUrl(owner, repo, config.github.baseBranch, branchName);
      await postSlackMessage(
        job.channelId,
        `✅ ${issueContext.identifier} done — added to the shared branch \`${branchName}\`. No PR yet; a PR against \`${config.github.baseBranch}\` will be opened manually from the latest branch when ready for review.\nCompare: ${compareUrl}`,
        job.threadTs
      );
    }

    console.log(`Finished job #${job.id} (${job.linearIssueIdentifier}) — branch: ${branchName}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Job #${job.id} (${job.linearIssueIdentifier}) failed:`, err);

    Jobs.markFailed(db, job.id, message);
    await moveIssueToStateType(job.linearIssueId, "canceled", ["Failed"]).catch(() => {});

    if (job.channelId && job.threadTs) {
      await postSlackMessage(
        job.channelId,
        `❌ ${job.linearIssueIdentifier} failed: ${message}`,
        job.threadTs
      ).catch(() => {});
    }
  } finally {
    if (cloneDir) {
      await cleanupClone(cloneDir);
    }
  }
}
