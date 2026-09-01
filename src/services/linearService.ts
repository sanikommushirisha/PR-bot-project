import type { WorkflowState } from "@linear/sdk";
import { linearClient } from "../config/clients.js";
import { config } from "../config/env.js";
import { buildSlackMetaMarker, type SlackMeta } from "./slackService.js";

export interface LinearTeam {
  id: string;
  key: string;
  statesByType: Map<string, WorkflowState[]>;
}

let cachedTeam: LinearTeam | undefined;

/** Resolves LINEAR_TEAM_KEY to its id and workflow states grouped by category. Cached for the process lifetime. */
export async function resolveTeam(): Promise<LinearTeam> {
  if (cachedTeam) return cachedTeam;

  const teams = await linearClient.teams({ filter: { key: { eq: config.linear.teamKey } } });
  const team = teams.nodes[0];
  if (!team) {
    throw new Error(`No Linear team found with key "${config.linear.teamKey}". Check LINEAR_TEAM_KEY.`);
  }

  const states = await team.states();
  const statesByType = new Map<string, WorkflowState[]>();
  for (const state of states.nodes) {
    const list = statesByType.get(state.type) ?? [];
    list.push(state);
    statesByType.set(state.type, list);
  }

  cachedTeam = { id: team.id, key: config.linear.teamKey, statesByType };
  return cachedTeam;
}

function pickStateId(team: LinearTeam, type: string, preferredNames: string[] = []): string | undefined {
  const candidates = team.statesByType.get(type);
  if (!candidates || candidates.length === 0) return undefined;

  for (const name of preferredNames) {
    const match = candidates.find((state) => state.name.toLowerCase() === name.toLowerCase());
    if (match) return match.id;
  }

  return [...candidates].sort((a, b) => a.position - b.position)[0]?.id;
}

export interface CreatedLinearIssue {
  issueId: string;
  identifier: string;
  url: string;
}

export async function createTaskIssue(params: {
  taskDescription: string;
  requestingUsername: string | null;
  slackMeta: SlackMeta;
}): Promise<CreatedLinearIssue> {
  const team = await resolveTeam();
  const stateId = pickStateId(team, "unstarted") ?? pickStateId(team, "backlog");

  const title =
    params.taskDescription.length > 100 ? `${params.taskDescription.slice(0, 97)}...` : params.taskDescription;

  const description = [
    `**Requested by:** ${params.requestingUsername ?? "unknown"}`,
    "",
    params.taskDescription,
    "",
    buildSlackMetaMarker(params.slackMeta),
  ].join("\n");

  const payload = await linearClient.createIssue({ teamId: team.id, title, description, stateId });
  const issue = await payload.issue;
  if (!payload.success || !issue) {
    throw new Error("Linear createIssue did not return an issue.");
  }

  return { issueId: issue.id, identifier: issue.identifier, url: issue.url };
}

/** Moves an issue to the first workflow state of the given type (e.g. "started", "completed", "canceled"), preferring a state whose name matches one of `preferredNames`. */
export async function moveIssueToStateType(
  issueId: string,
  type: string,
  preferredNames: string[] = []
): Promise<void> {
  const team = await resolveTeam();
  const stateId = pickStateId(team, type, preferredNames);
  if (!stateId) return;
  await linearClient.updateIssue(issueId, { stateId });
}

/**
 * Moves an issue to the workflow state with this exact name, searching
 * across all state types (not just one) — used to push a newly created
 * issue straight into the configured trigger state as a genuine state
 * transition, so it fires through the normal webhook path exactly like a
 * human dragging the card would (a fresh `createIssue` call with the state
 * already set wouldn't fire an "update" event with `updatedFrom.stateId`,
 * since there's no prior state to transition from).
 */
export async function moveIssueToStateName(issueId: string, name: string): Promise<boolean> {
  const team = await resolveTeam();
  for (const states of team.statesByType.values()) {
    const match = states.find((state) => state.name.toLowerCase() === name.toLowerCase());
    if (match) {
      await linearClient.updateIssue(issueId, { stateId: match.id });
      return true;
    }
  }
  return false;
}

export interface FullIssueContext {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  comments: string[];
}

/** Fetches an issue plus its discussion comments, for handing to Claude as context. */
export async function fetchFullIssueContext(issueId: string): Promise<FullIssueContext> {
  const issue = await linearClient.issue(issueId);
  const commentConnection = await issue.comments();

  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description ?? null,
    comments: commentConnection.nodes.map((comment) => comment.body),
  };
}
