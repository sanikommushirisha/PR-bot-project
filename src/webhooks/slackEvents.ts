import type { Request, Response } from "express";
import type Database from "better-sqlite3";
import { config } from "../config/env.js";
import { slackClient } from "../config/clients.js";
import { SlackThreads } from "../db/index.js";
import { postSlackMessage, fetchThreadRootMessage, extractLinearIssueIdentifier } from "../services/slackService.js";
import { downloadSlackFile } from "../services/slackFileService.js";
import { uploadImageToLinear, appendImageToIssueDescription } from "../services/linearAssetService.js";
import { addIssueComment, resolveIssueIdByIdentifier } from "../services/linearService.js";
import type { SlackEventsPayload, SlackFileSharedEvent, SlackMessageEvent } from "../types/slack.js";

function isFileSharedEvent(event: { type: string }): event is SlackFileSharedEvent {
  return event.type === "file_shared";
}

function isUserMessageEvent(event: { type: string }): event is SlackMessageEvent {
  return event.type === "message";
}

/**
 * Looks up which Linear issue a Slack thread belongs to. Threads created by
 * this bot's own /task command are already registered in `slack_threads`. A
 * thread this bot didn't create — e.g. Linear's own Slack notification for an
 * issue created directly in Linear — isn't, so as a fallback this checks
 * whether the thread's root message names an issue and, if so, adopts it and
 * caches the mapping so later replies in the same thread skip the lookup.
 */
async function resolveIssueIdForThread(
  db: Database.Database,
  channel: string,
  threadTs: string
): Promise<string | undefined> {
  const known = SlackThreads.getIssueId(db, channel, threadTs);
  if (known) return known;

  const rootText = await fetchThreadRootMessage(channel, threadTs).catch(() => undefined);
  const identifier = extractLinearIssueIdentifier(rootText);
  if (!identifier) return undefined;

  const issueId = await resolveIssueIdByIdentifier(identifier);
  if (issueId) SlackThreads.recordThread(db, channel, threadTs, issueId);
  return issueId;
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

  const issueId = await resolveIssueIdForThread(db, event.channel_id, threadTs);
  if (!issueId) return; // not a task thread, and not a recognizable Linear notification thread either — unrelated upload

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
 * A reply typed into a task's Slack thread — e.g. "there's a bug in the
 * login flow" or "also handle the empty-state case". Folds the text into
 * the Linear issue as a comment, so `fetchFullIssueContext` picks it up
 * whenever the issue is next run (or re-run). This never moves the issue's
 * state on its own — starting/resuming a run always stays an explicit state
 * change in Linear (dragging the card, `/fix`, or the Linear UI/API), the
 * same for a `/task` thread as for one adopted from Linear's own
 * notification (see `resolveIssueIdForThread`) — so both work identically
 * and a reply never surprises you with a run you didn't ask for.
 */
async function handleThreadFollowUp(db: Database.Database, event: SlackMessageEvent): Promise<void> {
  if (event.channel !== config.slack.allowedChannelId) return;
  if (event.subtype || event.bot_id) return; // ignore edits/deletes and the bot's own posts
  if (!event.thread_ts || !event.text?.trim()) return;

  const issueId = await resolveIssueIdForThread(db, event.channel, event.thread_ts);
  if (!issueId) return; // not a task thread, and not a recognizable Linear notification thread either — unrelated conversation

  const commentBody = `**Follow-up from Slack:**\n\n${event.text}`;

  try {
    await addIssueComment(issueId, commentBody);
    await postSlackMessage(event.channel, "📝 Added your note to the linked Linear issue.", event.thread_ts);
  } catch (err) {
    console.error(`Failed to add Slack reply as a comment on issue ${issueId}:`, err);
    await postSlackMessage(
      event.channel,
      `❌ Couldn't add your note to the Linear issue: ${err instanceof Error ? err.message : String(err)}`,
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
