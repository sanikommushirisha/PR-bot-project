import { App } from "@slack/bolt";
import type { WebClient } from "@slack/web-api";
import type Database from "better-sqlite3";
import { config } from "../config/index.js";
import { Jobs } from "../db/index.js";
import { TASK_REPO_TARGETS, type TaskRepoTarget } from "./repos.js";

export function createBot(db: Database.Database): App {
  const app = new App({
    token: config.slack.botToken,
    appToken: config.slack.appToken,
    socketMode: true,
  });

  for (const target of TASK_REPO_TARGETS) {
    registerTaskCommand(app, db, target);
  }

  app.command("/status-bot", async ({ command, ack, respond }) => {
    await ack();
    if (command.channel_id !== config.slack.allowedChannelId) return;

    const active = Jobs.listActive(db);
    if (active.length === 0) {
      await respond({ response_type: "ephemeral", text: "Queue is empty — no pending or running jobs." });
      return;
    }

    const runningCount = active.filter((j) => j.status === "running").length;
    const pendingCount = active.filter((j) => j.status === "pending").length;

    const lines = [
      `${runningCount} running, ${pendingCount} queued:`,
      "",
      ...active.map((job) => {
        const desc =
          job.taskDescription.length > 60
            ? `${job.taskDescription.slice(0, 57)}...`
            : job.taskDescription;
        return `#${job.id} [${job.status}] [${job.targetRepo}] ${desc}`;
      }),
    ];

    await respond({ response_type: "ephemeral", text: lines.join("\n") });
  });

  app.command("/cancel", async ({ command, ack, respond }) => {
    await ack();
    if (command.channel_id !== config.slack.allowedChannelId) return;

    const jobId = Number(command.text.trim());
    if (!Number.isInteger(jobId) || jobId <= 0) {
      await respond({ response_type: "ephemeral", text: "Usage: /cancel <job id> — see /status-bot for ids." });
      return;
    }

    const cancelled = Jobs.cancelPending(db, jobId, "Cancelled by user via /cancel");
    if (cancelled) {
      await respond({ response_type: "ephemeral", text: `Job #${jobId} cancelled.` });
      return;
    }

    const job = Jobs.getById(db, jobId);
    if (!job) {
      await respond({ response_type: "ephemeral", text: `Job #${jobId} not found.` });
    } else if (job.status === "running") {
      await respond({
        response_type: "ephemeral",
        text: `Job #${jobId} is already running and can't be cancelled mid-flight yet — it'll finish (or fail) on its own.`,
      });
    } else {
      await respond({
        response_type: "ephemeral",
        text: `Job #${jobId} is already ${job.status} — nothing to cancel.`,
      });
    }
  });

  app.command("/help", async ({ command, ack, respond }) => {
    await ack();
    if (command.channel_id !== config.slack.allowedChannelId) return;

    const text = [
      "Commands:",
      ...TASK_REPO_TARGETS.map(
        (target) => `${target.command} <description> — queue a job against \`${target.slug}\`; opens a draft PR when done.`
      ),
      "/status-bot — show pending/running jobs.",
      "/cancel <job id> — cancel a job that hasn't started running yet.",
      "/help — show this message.",
    ].join("\n");

    await respond({ response_type: "ephemeral", text });
  });

  return app;
}

function registerTaskCommand(app: App, db: Database.Database, target: TaskRepoTarget): void {
  app.command(target.command, async ({ command, ack, client, respond }) => {
    // Ack first, before any DB or Slack API work — Slack retries the command
    // if this isn't called within 3 seconds, so this ordering is what keeps
    // a slow job-creation path from ever causing a duplicate job.
    await ack();

    if (command.channel_id !== config.slack.allowedChannelId) {
      console.warn(
        `Ignored ${target.command} from channel ${command.channel_id} (configured SLACK_ALLOWED_CHANNEL_ID is ${config.slack.allowedChannelId}).`
      );
      return;
    }

    const taskDescription = command.text.trim();
    if (!taskDescription) {
      await respond({
        response_type: "ephemeral",
        text: `Usage: ${target.command} <description of what you want done>`,
      });
      return;
    }

    // Slack includes `thread_ts` on the slash-command payload when it's run
    // from inside an existing thread. This is the closest Slack equivalent
    // to Telegram's "reply to a message to attach context" — if it's absent
    // (e.g. run in the main channel), contextNote is simply null.
    const invocationThreadTs = (command as unknown as { thread_ts?: string }).thread_ts;

    const contextNote = invocationThreadTs
      ? await fetchThreadParentText(client, command.channel_id, invocationThreadTs)
      : null;

    const job = Jobs.create(db, {
      taskDescription,
      contextNote,
      requestingUserId: command.user_id,
      requestingUsername: command.user_name ?? null,
      channelId: command.channel_id,
      targetRepo: target.slug,
      targetBaseBranch: target.baseBranch,
    });

    const ackMessage = await client.chat.postMessage({
      channel: command.channel_id,
      thread_ts: invocationThreadTs,
      text: `Got it — job #${job.id} queued for \`${target.slug}\`:\n> ${taskDescription}\nI'll open a draft PR and post updates in this thread when it's ready.`,
    });

    if (ackMessage.ts) {
      Jobs.markThread(db, job.id, ackMessage.ts);
    }
  });
}

async function fetchThreadParentText(
  client: WebClient,
  channelId: string,
  threadTs: string
): Promise<string | null> {
  try {
    const result = await client.conversations.replies({ channel: channelId, ts: threadTs, limit: 1 });
    const parent = result.messages?.[0];
    return parent && typeof parent.text === "string" && parent.text ? parent.text : null;
  } catch (err) {
    console.warn(
      `Could not fetch thread parent message for context (channel ${channelId}, thread ${threadTs}):`,
      err instanceof Error ? err.message : err
    );
    return null;
  }
}
