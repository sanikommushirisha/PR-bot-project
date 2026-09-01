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

export async function updateSlackMessage(channel: string, ts: string, text: string): Promise<void> {
  await slackClient.chat.update({ channel, ts, text });
}
