export interface LinearWebhookIssueState {
  id: string;
  name: string;
  type: string;
}

export interface LinearWebhookIssueData {
  id: string;
  identifier: string;
  title: string;
  description?: string | null;
  state?: LinearWebhookIssueState;
  priority?: number;
  teamId?: string;
  url?: string;
}

export interface LinearWebhookPayload {
  action: "create" | "update" | "remove";
  type: string;
  data: LinearWebhookIssueData;
  /** Present on "update" actions — keys are the fields that changed, e.g. `stateId` when the workflow state moved. */
  updatedFrom?: Record<string, unknown>;
  createdAt?: string;
  url?: string;
}
