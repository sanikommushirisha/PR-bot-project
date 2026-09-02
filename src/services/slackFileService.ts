import { config } from "../config/env.js";

/** Slack's private file URLs (url_private) only serve the bytes with the bot token attached — https://api.slack.com/apis/private-file-urls */
export async function downloadSlackFile(urlPrivate: string): Promise<Buffer> {
  const res = await fetch(urlPrivate, {
    headers: { Authorization: `Bearer ${config.slack.botToken}` },
  });
  if (!res.ok) {
    throw new Error(`Failed to download Slack file (${res.status}): ${urlPrivate}`);
  }
  return Buffer.from(await res.arrayBuffer());
}
