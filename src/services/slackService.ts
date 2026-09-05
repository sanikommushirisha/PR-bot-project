import { slackClient } from "../config/clients.js";

const SLACK_META_PATTERN = /<!-- slack-meta: (\{.*?\}) -->/;

export interface SlackMeta {
  channelId: string;
  threadTs: string;
}

/** Embedded in a Linear issue's description so the stateless Linear-webhook handler can find its way back to the originating Slack thread without any database. */
export function buildSlackMetaMarker(meta: SlackMeta): string {
  return `<!-- slack-meta: ${JSON.stringify(meta)} -->`;
}

export function parseSlackMetaMarker(description: string | null | undefined): SlackMeta | null {
  if (!description) return null;
  const match = description.match(SLACK_META_PATTERN);
  if (!match) return null;

  try {
    const parsed = JSON.parse(match[1]);
    if (typeof parsed.channelId === "string" && typeof parsed.threadTs === "string") {
      return { channelId: parsed.channelId, threadTs: parsed.threadTs };
    }
    return null;
  } catch {
    return null;
  }
}

export async function postSlackMessage(channel: string, text: string, threadTs?: string): Promise<string | undefined> {
  const result = await slackClient.chat.postMessage({ channel, text, thread_ts: threadTs });
  return result.ts;
}

const LINEAR_ISSUE_URL_PATTERN = /linear\.app\/[^/\s]+\/issue\/([A-Za-z][A-Za-z0-9]*-\d+)/i;
const LINEAR_ISSUE_IDENTIFIER_PATTERN = /\b([A-Z][A-Z0-9]{1,9}-\d+)\b/;

/**
 * Extracts a Linear issue identifier (e.g. "LES-23") from a Slack message's
 * text — used to recognize the notification Linear's own Slack app posts
 * when an issue is created directly in Linear (as opposed to via /task),
 * so replies in that thread can still be traced back to an issue.
 */
export function extractLinearIssueIdentifier(text: string | undefined): string | undefined {
  if (!text) return undefined;
  return (text.match(LINEAR_ISSUE_URL_PATTERN) ?? text.match(LINEAR_ISSUE_IDENTIFIER_PATTERN))?.[1];
}

/** Fetches a thread's root message text, for recognizing a thread that originated from Linear's own Slack notification rather than this bot's /task command. */
export async function fetchThreadRootMessage(channel: string, threadTs: string): Promise<string | undefined> {
  const result = await slackClient.conversations.replies({ channel, ts: threadTs, limit: 1, inclusive: true });
  return result.messages?.[0]?.text;
}

export async function updateSlackMessage(channel: string, ts: string, text: string): Promise<void> {
  await slackClient.chat.update({ channel, ts, text });
}
