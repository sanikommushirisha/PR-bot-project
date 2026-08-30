import type { Telegram } from "telegraf";
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
import { buildTelegramMessageLink } from "../telegram/links.js";

export interface WorkerDeps {
  db: Database.Database;
  telegram: Telegram;
}

export async function processJob(job: Job, deps: WorkerDeps): Promise<void> {
  const { db, telegram } = deps;
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
      body: formatPrBody(job, agentResult.summary),
    });

    Jobs.markCompleted(db, job.id, prUrl);
    await notify(telegram, job, `✅ Job #${job.id} done — draft PR opened:\n${prUrl}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    Jobs.markFailed(db, job.id, message);
    await notify(telegram, job, `❌ Job #${job.id} failed: ${message}`);
  } finally {
    if (cloneDir) {
      await cleanupClone(cloneDir);
    }
  }
}

async function notify(telegram: Telegram, job: Job, text: string): Promise<void> {
  try {
    if (job.messageThreadId !== null) {
      await telegram.sendMessage(job.chatId, text, {
        message_thread_id: Number(job.messageThreadId),
      });
    } else {
      await telegram.sendMessage(job.chatId, text, {
        reply_parameters: { message_id: Number(job.messageId) },
      });
    }
  } catch (err) {
    console.error(`Failed to send Telegram notification for job #${job.id}:`, err);
  }
}

function formatCommitMessage(job: Job): string {
  return [
    `Automated change via telegram-agent-bridge (job #${job.id})`,
    "",
    `Requested by ${job.requestingUsername ?? job.requestingUserId} in Telegram chat ${job.chatId}, message ${job.messageId}.`,
    "",
    job.taskDescription,
  ].join("\n");
}

function formatPrTitle(job: Job): string {
  const trimmed =
    job.taskDescription.length > 72 ? `${job.taskDescription.slice(0, 69)}...` : job.taskDescription;
  return `[agent] ${trimmed}`;
}

function formatPrBody(job: Job, agentSummary: string): string {
  const lines = [
    "## Requested via Telegram",
    "",
    `> ${job.taskDescription}`,
    "",
    `Requested by: ${job.requestingUsername ?? job.requestingUserId}`,
  ];

  const link = buildTelegramMessageLink(
    job.chatId,
    job.messageThreadId ?? job.messageId
  );
  if (link) lines.push(job.messageThreadId ? `Telegram thread: ${link}` : `Original message: ${link}`);

  lines.push(
    "",
    "## Agent summary",
    "",
    agentSummary,
    "",
    "---",
    `_Job #${job.id} — opened automatically by telegram-agent-bridge. This is a draft; review before merging._`
  );

  return lines.join("\n");
}
