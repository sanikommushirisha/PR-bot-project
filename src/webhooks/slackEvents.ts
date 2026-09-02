import type { Request, Response } from "express";
import type Database from "better-sqlite3";
import { config } from "../config/env.js";
import { slackClient } from "../config/clients.js";
import { SlackThreads } from "../db/index.js";
import { postSlackMessage } from "../services/slackService.js";
import { downloadSlackFile } from "../services/slackFileService.js";
import { uploadImageToLinear, appendImageToIssueDescription } from "../services/linearAssetService.js";
import type { SlackEventsPayload, SlackFileSharedEvent } from "../types/slack.js";

function isFileSharedEvent(event: { type: string }): event is SlackFileSharedEvent {
  return event.type === "file_shared";
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

export function createSlackEventsHandler(db: Database.Database) {
  return async function handleSlackEvent(req: Request, res: Response): Promise<void> {
    const payload = req.body as SlackEventsPayload;

    if (payload.type === "url_verification") {
      res.status(200).type("text/plain").send(payload.challenge);
      return;
    }

    // Ack immediately — Slack retries on anything but a fast 200. The actual
    // work (downloading, re-uploading) happens as a background continuation.
    res.status(200).send();

    if (payload.type !== "event_callback" || !isFileSharedEvent(payload.event)) return;

    await handleFileShared(db, payload.event).catch((err) => {
      console.error("Unhandled error while forwarding a Slack image to Linear:", err);
    });
  };
}
