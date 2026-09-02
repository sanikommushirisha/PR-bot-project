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

export type SlackEventsPayload =
  | { type: "url_verification"; token: string; challenge: string }
  | {
      type: "event_callback";
      team_id: string;
      api_app_id: string;
      event: SlackFileSharedEvent | { type: string; [key: string]: unknown };
    };
