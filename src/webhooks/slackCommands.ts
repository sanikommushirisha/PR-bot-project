import type { Request, Response } from "express";
import type Database from "better-sqlite3";
import { config } from "../config/env.js";
import { createTaskIssue, moveIssueToStateName } from "../services/linearService.js";
import { postSlackMessage, updateSlackMessage } from "../services/slackService.js";
import { ReviewState, SlackThreads } from "../db/index.js";
import type { SlackSlashCommandPayload } from "../types/slack.js";

export function createTaskCommandHandler(db: Database.Database) {
  return async function handleSlackTaskCommand(req: Request, res: Response): Promise<void> {
    const body = req.body as SlackSlashCommandPayload;

    // Ack immediately — Slack requires a response within 3 seconds. Everything
    // below runs as a background continuation after this returns.
    res.status(200).send();

    if (body.channel_id !== config.slack.allowedChannelId) {
      console.warn(
        `Ignored ${body.command} from channel ${body.channel_id} (configured SLACK_ALLOWED_CHANNEL_ID is ${config.slack.allowedChannelId}).`
      );
      return;
    }

    const taskDescription = body.text?.trim();
    if (!taskDescription) {
      await postSlackMessage(
        body.channel_id,
        `Usage: ${body.command} <description of what you want done>`,
        body.thread_ts
      );
      return;
    }

    try {
      // Post first so we have a message ts to both thread future updates under
      // and embed into the Linear issue as the back-reference to this thread.
      const placeholderTs = await postSlackMessage(
        body.channel_id,
        `Registering task: "${taskDescription}"...`,
        body.thread_ts
      );

      if (!placeholderTs) {
        console.error("Slack postMessage did not return a ts — cannot register a task without a thread anchor.");
        return;
      }

      const issue = await createTaskIssue({
        taskDescription,
        requestingUsername: body.user_name ?? null,
        slackMeta: { channelId: body.channel_id, threadTs: placeholderTs },
      });

      // Lets a later message in this same thread (e.g. an image) find its
      // way back to this issue before any `jobs` row exists for it.
      SlackThreads.recordThread(db, body.channel_id, placeholderTs, issue.issueId);

      await updateSlackMessage(
        body.channel_id,
        placeholderTs,
        `📝 Task registered as *${issue.identifier}* in Linear:\n> ${taskDescription}\nMove it to "*${config.linear.triggerStateName}*" in Linear when you want the agent to start working on it. <${issue.url}|View in Linear>`
      );
    } catch (err) {
      console.error("Failed to register Slack task as a Linear issue:", err);
      await postSlackMessage(
        body.channel_id,
        `❌ Failed to register task: ${err instanceof Error ? err.message : String(err)}`,
        body.thread_ts
      ).catch(() => {});
    }
  };
}

export function createFixReviewCommandHandler(db: Database.Database) {
  return async function handleFixReviewCommand(req: Request, res: Response): Promise<void> {
    const body = req.body as SlackSlashCommandPayload;

    res.status(200).send();

    if (body.channel_id !== config.slack.allowedChannelId) {
      console.warn(
        `Ignored ${body.command} from channel ${body.channel_id} (configured SLACK_ALLOWED_CHANNEL_ID is ${config.slack.allowedChannelId}).`
      );
      return;
    }

    const state = ReviewState.get(db);
    if (!state.pendingFlagFindings) {
      await postSlackMessage(
        body.channel_id,
        "Nothing pending — no outstanding review flag to fix.",
        body.thread_ts
      );
      return;
    }

    // Thread everything about this fix under the original flag message when
    // we have one; otherwise fall back to wherever /fix itself was
    // typed, or the channel root, so the catch block always has somewhere
    // sensible to report failure.
    let flagThreadTs = state.pendingFlagThreadTs ?? body.thread_ts;

    try {
      if (!flagThreadTs) {
        flagThreadTs = await postSlackMessage(body.channel_id, "Starting the fix...", body.thread_ts);
        if (!flagThreadTs) {
          throw new Error("Slack postMessage did not return a ts — cannot proceed without a thread anchor.");
        }
      }

      const taskDescription = `Fix the following issue(s) flagged by automated review:\n\n${state.pendingFlagFindings}`;

      const issue = await createTaskIssue({
        taskDescription,
        requestingUsername: body.user_name ?? null,
        slackMeta: { channelId: body.channel_id, threadTs: flagThreadTs },
      });

      // A fresh createIssue call already lands in the initial "unstarted"
      // state — this second call is a genuine state transition, which is
      // what actually fires the webhook that enqueues it (see
      // moveIssueToStateName's doc comment for why this can't be done in
      // one step).
      const moved = await moveIssueToStateName(issue.issueId, config.linear.triggerStateName);
      if (!moved) {
        throw new Error(`Could not find a workflow state named "${config.linear.triggerStateName}".`);
      }

      ReviewState.clearPendingFlag(db);

      await postSlackMessage(
        body.channel_id,
        `Got it — created *${issue.identifier}* and started the agent on it. <${issue.url}|View in Linear>`,
        flagThreadTs
      );
    } catch (err) {
      console.error("Failed to act on /fix:", err);
      await postSlackMessage(
        body.channel_id,
        `❌ Failed to start the fix: ${err instanceof Error ? err.message : String(err)}`,
        flagThreadTs
      ).catch(() => {});
    }
  };
}

/**
 * Slack lets multiple slash commands share one Request URL — /task and
 * /fix are both configured to point here, dispatched by `command`.
 */
export function createSlackCommandsHandler(db: Database.Database) {
  const fixReviewHandler = createFixReviewCommandHandler(db);
  const taskHandler = createTaskCommandHandler(db);

  return async function dispatch(req: Request, res: Response): Promise<void> {
    const command = (req.body as SlackSlashCommandPayload).command;
    if (command === "/fix") {
      await fixReviewHandler(req, res);
    } else {
      await taskHandler(req, res);
    }
  };
}
