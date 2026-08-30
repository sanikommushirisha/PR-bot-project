/** Shape of a single unit of work, from Telegram trigger through to PR creation. */
export interface AgentTaskJob {
  /** Freeform request text pulled from the Telegram message/command. */
  taskDescription: string;
  /** Telegram user ID of whoever triggered the task. */
  requestedByUserId: string;
  /** Telegram chat ID the trigger happened in, used to post status updates back. */
  telegramChatId: string;
  /** Telegram message ID of the triggering message, replied to for status updates. */
  telegramMessageId: string;
  /** Link to the originating Telegram message (t.me/... for public chats), embedded in the PR body. */
  telegramMessageLink: string;
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
