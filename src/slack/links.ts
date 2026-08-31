import type { WebClient } from "@slack/web-api";

/**
 * Slack permalinks encode the workspace subdomain, which isn't derivable
 * from a channel/message id alone — unlike Telegram's link, this has to be
 * fetched from the API. Best-effort: returns null on any failure rather than
 * failing the PR body.
 */
export async function buildSlackPermalink(
  client: WebClient,
  channelId: string,
  messageTs: string
): Promise<string | null> {
  try {
    const result = await client.chat.getPermalink({ channel: channelId, message_ts: messageTs });
    return result.permalink ?? null;
  } catch (err) {
    console.warn(
      `Could not fetch Slack permalink for ${channelId}/${messageTs}:`,
      err instanceof Error ? err.message : err
    );
    return null;
  }
}
