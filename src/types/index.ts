/** Shape of a single unit of work, from Slack trigger through to PR creation. */
export interface AgentTaskJob {
  /** Freeform request text pulled from the Slack message/command. */
  taskDescription: string;
  /** Slack user ID of whoever triggered the task. */
  requestedByUserId: string;
  /** Slack channel ID the trigger happened in, used to post status updates back. */
  slackChannelId: string;
  /** Slack thread ts (the parent message ts) status updates should reply into. */
  slackThreadTs: string;
  /** Permalink to the originating Slack message/thread, embedded in the PR body. */
  slackPermalink: string;
  /** "owner/repo" the agent should work against. */
  targetRepo: string;
  /** Base branch the PR should target, e.g. "main". */
  targetBaseBranch: string;
}

export interface PullRequestResult {
  url: string;
  number: number;
  branch: string;
}
