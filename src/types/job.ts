export type JobStatus = "pending" | "running" | "completed" | "failed";

export interface Job {
  id: number;
  linearIssueId: string;
  linearIssueIdentifier: string;
  linearIssueTitle: string;
  linearIssueDescription: string | null;
  channelId: string | null;
  threadTs: string | null;
  status: JobStatus;
  /** Linear's own scale: 0 = No priority, 1 = Urgent, 2 = High, 3 = Medium, 4 = Low. */
  priority: number;
  /** The branch this job's changes were pushed to, once completed. */
  branchName: string | null;
  errorMessage: string | null;
  attempts: number;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface EnqueueJobInput {
  linearIssueId: string;
  linearIssueIdentifier: string;
  linearIssueTitle: string;
  linearIssueDescription: string | null;
  channelId: string | null;
  threadTs: string | null;
}
