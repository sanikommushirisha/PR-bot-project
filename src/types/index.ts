export type JobStatus = "pending" | "running" | "completed" | "failed";

export interface Job {
  id: number;
  taskDescription: string;
  contextNote: string | null;
  requestingUserId: string;
  requestingUsername: string | null;
  channelId: string;
  threadTs: string | null;
  targetRepo: string;
  targetBaseBranch: string;
  status: JobStatus;
  branchName: string | null;
  prUrl: string | null;
  errorMessage: string | null;
  attempts: number;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface CreateJobInput {
  taskDescription: string;
  contextNote?: string | null;
  requestingUserId: string;
  requestingUsername: string | null;
  channelId: string;
  targetRepo: string;
  targetBaseBranch: string;
}
