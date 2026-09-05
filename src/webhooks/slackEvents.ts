import type { Request, Response } from "express";
import type Database from "better-sqlite3";
import { config } from "../config/env.js";
import { slackClient } from "../config/clients.js";
import { SlackThreads, Jobs } from "../db/index.js";
import { postSlackMessage } from "../services/slackService.js";
import { downloadSlackFile } from "../services/slackFileService.js";
import { uploadImageToLinear, appendImageToIssueDescription } from "../services/linearAssetService.js";
import { addIssueComment, moveIssueToStateName } from "../services/linearService.js";
import type { SlackEventsPayload, SlackFileSharedEvent, SlackMessageEvent } from "../types/slack.js";

function isFileSharedEvent(event: { type: string }): event is SlackFileSharedEvent {
  return event.type === "file_shared";
}

function isUserMessageEvent(event: { type: string }): event is SlackMessageEvent {
  return event.type === "message";
}

async function handleFileShared(db: Database.Database, event: SlackFileSharedEvent): Promise<void> {
  if (event.channel_id !== config.slack.allowedChannelId) return;

  const info = await slackClient.files.info({ file: event.file_id });
  const file = info.file;
  if (!file?.mimetype?.startsWith("image/") || !file.url_private || !file.name) return;

  // The event itself doesn't carry which thread the file landed in — that
  // only comes back from files.info's `shares`, keyed by channel.
  const shares = [
    ...(file.shares?.public?.[event.channel_id] ?? []),
    ...(file.shares?.private?.[event.channel_id] ?? []),
  ];
  const share = shares[0];
  const threadTs = share?.thread_ts ?? share?.ts;
  if (!threadTs) return;

  const issueId = SlackThreads.getIssueId(db, event.channel_id, threadTs);
  if (!issueId) return; // not a thread /task registered — unrelated upload

  try {
    const buffer = await downloadSlackFile(file.url_private);
    const assetUrl = await uploadImageToLinear(buffer, file.name, file.mimetype);
    await appendImageToIssueDescription(issueId, assetUrl, file.name);
    await postSlackMessage(event.channel_id, `📎 Added *${file.name}* to the linked Linear issue.`, threadTs);
  } catch (err) {
    console.error(`Failed to forward Slack image "${file.name}" to Linear issue ${issueId}:`, err);
    await postSlackMessage(
      event.channel_id,
      `❌ Couldn't add *${file.name}* to the Linear issue: ${err instanceof Error ? err.message : String(err)}`,
      threadTs
    ).catch(() => {});
  }
}

/**
 * A reply typed into a task's Slack thread after the agent has already
 * finished (or failed) — e.g. "there's a bug in the login flow" or "also
 * handle the empty-state case". Folds the text into the Linear issue as a
 * comment and, if nothing is currently running for it, moves it back to the
 * trigger state so the normal Linear-webhook path (see linearEvents.ts)
 * enqueues a fresh run — the same re-trigger mechanism `/fix` and manually
 * dragging the card in Linear already use.
 */
async function handleThreadFollowUp(db: Database.Database, event: SlackMessageEvent): Promise<void> {
  if (event.channel !== config.slack.allowedChannelId) return;
  if (event.subtype || event.bot_id) return; // ignore edits/deletes and the bot's own posts
  if (!event.thread_ts || !event.text?.trim()) return;

  const issueId = SlackThreads.getIssueId(db, event.channel, event.thread_ts);
  if (!issueId) return; // not a thread /task registered — unrelated conversation

  const commentBody = `**Follow-up from Slack:**\n\n${event.text}`;

  if (Jobs.getActiveByIssueId(db, issueId)) {
    // Already pending/running — the comment lands in Linear for context, but
    // starting a second concurrent run for the same issue isn't safe, so
    // just let the current run finish first.
    await addIssueComment(issueId, commentBody).catch((err) => {
      console.error(`Failed to add Slack follow-up comment to issue ${issueId}:`, err);
    });
    await postSlackMessage(
      event.channel,
      "Noted — still finishing the current run, I'll pick this up right after.",
      event.thread_ts
    ).catch(() => {});
    return;
  }

  try {
    await addIssueComment(issueId, commentBody);
    const moved = await moveIssueToStateName(issueId, config.linear.triggerStateName);
    if (!moved) {
      throw new Error(`Could not find a workflow state named "${config.linear.triggerStateName}".`);
    }
    await postSlackMessage(event.channel, "Got it — picking this back up now.", event.thread_ts);
  } catch (err) {
    console.error(`Failed to resume issue ${issueId} from a Slack thread follow-up:`, err);
    await postSlackMessage(
      event.channel,
      `❌ Couldn't restart work on this: ${err instanceof Error ? err.message : String(err)}`,
      event.thread_ts
    ).catch(() => {});
  }
}

export function createSlackEventsHandler(db: Database.Database) {
  return async function handleSlackEvent(req: Request, res: Response): Promise<void> {
    const payload = req.body as SlackEventsPayload;

    if (payload.type === "url_verification") {
      res.status(200).type("text/plain").send(payload.challenge);
      return;
    }

    // Ack immediately — Slack retries on anything but a fast 200. The actual
    // work (downloading, re-uploading, or resuming a job) happens as a
    // background continuation.
    res.status(200).send();

    if (payload.type !== "event_callback") return;

    if (isFileSharedEvent(payload.event)) {
      await handleFileShared(db, payload.event).catch((err) => {
        console.error("Unhandled error while forwarding a Slack image to Linear:", err);
      });
    } else if (isUserMessageEvent(payload.event)) {
      await handleThreadFollowUp(db, payload.event).catch((err) => {
        console.error("Unhandled error while handling a Slack thread follow-up:", err);
      });
    }
  };
}
