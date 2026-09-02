import type Database from "better-sqlite3";

function recordThread(db: Database.Database, channelId: string, threadTs: string, linearIssueId: string): void {
  db.prepare(
    "INSERT OR REPLACE INTO slack_threads (channel_id, thread_ts, linear_issue_id) VALUES (?, ?, ?)"
  ).run(channelId, threadTs, linearIssueId);
}

function getIssueId(db: Database.Database, channelId: string, threadTs: string): string | undefined {
  const row = db
    .prepare("SELECT linear_issue_id FROM slack_threads WHERE channel_id = ? AND thread_ts = ?")
    .get(channelId, threadTs) as { linear_issue_id: string } | undefined;
  return row?.linear_issue_id;
}

export const SlackThreads = {
  recordThread,
  getIssueId,
};
