import type { WebClient } from "@slack/web-api";
import type Database from "better-sqlite3";
import type { Job } from "../types/index.js";
import { config } from "../config/index.js";
import { Jobs } from "../db/index.js";
import {
  cloneRepo,
  createBranch,
  hasChanges,
  commitAll,
  pushBranch,
  cleanupClone,
  createOctokit,
  createDraftPullRequest,
  buildBranchName,
  parseRepoSlug,
} from "../github/index.js";
import { runAgentTask } from "../claude/index.js";
import { buildSlackPermalink } from "../slack/index.js";

export interface WorkerDeps {
  db: Database.Database;
  slack: WebClient;
}

export async function processJob(job: Job, deps: WorkerDeps): Promise<void> {
  const { db, slack } = deps;
  const { owner, repo } = parseRepoSlug(job.targetRepo);
  let cloneDir: string | undefined;

  try {
    const branchName = buildBranchName(job.taskDescription, job.id);

    const { git, dir } = await cloneRepo({
      owner,
      repo,
      token: config.github.auth.token,
      baseBranch: job.targetBaseBranch,
      scratchDir: config.worker.scratchDir,
      jobId: job.id,
    });
    cloneDir = dir;

    await createBranch(git, branchName);
    Jobs.markBranch(db, job.id, branchName);

    const agentResult = await runAgentTask({
      cwd: dir,
      taskDescription: job.taskDescription,
      requestingUsername: job.requestingUsername,
      chatContextNote: job.contextNote,
      anthropicApiKey: config.anthropic.apiKey,
    });

    if (!agentResult.success) {
      throw new Error(`Agent session did not complete successfully: ${agentResult.summary}`);
    }

    if (!(await hasChanges(git))) {
      throw new Error("Agent finished without making any file changes.");
    }

    await commitAll(git, formatCommitMessage(job));
    await pushBranch(git, branchName);

    const octokit = createOctokit(config.github.auth);
    const prUrl = await createDraftPullRequest({
      octokit,
      owner,
      repo,
      base: job.targetBaseBranch,
      head: branchName,
      title: formatPrTitle(job),
      body: await formatPrBody(slack, job, agentResult.summary),
    });

    Jobs.markCompleted(db, job.id, prUrl);
    await notify(slack, job, `✅ Job #${job.id} done — draft PR opened:\n${prUrl}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    Jobs.markFailed(db, job.id, message);
    await notify(slack, job, `❌ Job #${job.id} failed: ${message}`);
  } finally {
    if (cloneDir) {
      await cleanupClone(cloneDir);
    }
  }
}

async function notify(slack: WebClient, job: Job, text: string): Promise<void> {
  try {
    await slack.chat.postMessage({
      channel: job.channelId,
      thread_ts: job.threadTs ?? undefined,
      text,
    });
  } catch (err) {
    console.error(`Failed to send Slack notification for job #${job.id}:`, err);
  }
}

function formatCommitMessage(job: Job): string {
  return [
    `Automated change via slack-agent-bridge (job #${job.id})`,
    "",
    `Requested by ${job.requestingUsername ?? job.requestingUserId} in Slack channel ${job.channelId}.`,
    "",
    job.taskDescription,
  ].join("\n");
}

function formatPrTitle(job: Job): string {
  const trimmed =
    job.taskDescription.length > 72 ? `${job.taskDescription.slice(0, 69)}...` : job.taskDescription;
  return `[agent] ${trimmed}`;
}

async function formatPrBody(slack: WebClient, job: Job, agentSummary: string): Promise<string> {
  const lines = [
    "## Requested via Slack",
    "",
    `> ${job.taskDescription}`,
    "",
    `Requested by: ${job.requestingUsername ?? job.requestingUserId}`,
  ];

  const link = job.threadTs ? await buildSlackPermalink(slack, job.channelId, job.threadTs) : null;
  if (link) lines.push(`Slack thread: ${link}`);

  lines.push(
    "",
    "## Agent summary",
    "",
    agentSummary,
    "",
    "---",
    `_Job #${job.id} — opened automatically by slack-agent-bridge. This is a draft; review before merging._`
  );

  return lines.join("\n");
}
