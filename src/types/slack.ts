export interface SlackSlashCommandPayload {
  token: string;
  team_id: string;
  team_domain: string;
  channel_id: string;
  channel_name: string;
  user_id: string;
  user_name: string;
  command: string;
  text: string;
  response_url: string;
  trigger_id: string;
  api_app_id: string;
  /** Only present when the command was run from inside an existing thread — not in Slack's formal docs, but observed on real payloads. */
  thread_ts?: string;
}

/**
 * What actually arrives for an uploaded file is a `file_shared` event
 * (plus an earlier `file_created` we ignore — it fires before the file is
 * attached to any channel, so it has no `channel_id` yet). The full file
 * details (mimetype, url_private, and — critically — which thread it was
 * shared into) require a follow-up `files.info` call; the event itself only
 * carries the id.
 */
export interface SlackFileSharedEvent {
  type: "file_shared";
  file_id: string;
  channel_id: string;
  event_ts: string;
}

/**
 * A plain message posted in a channel/thread. `subtype` is absent on a
 * genuine new human message — present (e.g. "message_changed",
 * "message_deleted", "bot_message") on anything else, including messages
 * this bot itself posts via chat.postMessage (which also carry `bot_id`).
 */
export interface SlackMessageEvent {
  type: "message";
  channel: string;
  user?: string;
  text?: string;
  ts: string;
  thread_ts?: string;
  bot_id?: string;
  subtype?: string;
}

export type SlackEventsPayload =
  | { type: "url_verification"; token: string; challenge: string }
  | {
      type: "event_callback";
      team_id: string;
      api_app_id: string;
      event: SlackFileSharedEvent | SlackMessageEvent | { type: string; [key: string]: unknown };
    };
