import type { WorkflowState } from "@linear/sdk";
import { linearClient } from "../config/clients.js";
import { config } from "../config/env.js";
import { buildSlackMetaMarker, type SlackMeta } from "./slackService.js";
import { toIntegrationError } from "../errors/integrationError.js";

/** Wraps a Linear API call so any failure surfaces on the dashboard tagged as a Linear integration error, not a generic/unattributed one. */
async function callLinear<T>(context: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw toIntegrationError("linear", context, err);
  }
}

export interface LinearTeam {
  id: string;
  key: string;
  statesByType: Map<string, WorkflowState[]>;
}

let cachedTeam: LinearTeam | undefined;

/** Resolves LINEAR_TEAM_KEY to its id and workflow states grouped by category. Cached for the process lifetime. */
export async function resolveTeam(): Promise<LinearTeam> {
  if (cachedTeam) return cachedTeam;

  const teams = await callLinear("resolve team", () =>
    linearClient.teams({ filter: { key: { eq: config.linear.teamKey } } })
  );
  const team = teams.nodes[0];
  if (!team) {
    throw toIntegrationError(
      "linear",
      "resolve team",
      new Error(`No Linear team found with key "${config.linear.teamKey}". Check LINEAR_TEAM_KEY.`)
    );
  }

  const states = await callLinear("fetch team workflow states", () => team.states());
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

  const payload = await callLinear("create issue", () =>
    linearClient.createIssue({ teamId: team.id, title, description, stateId })
  );
  const issue = await payload.issue;
  if (!payload.success || !issue) {
    throw toIntegrationError("linear", "create issue", new Error("Linear createIssue did not return an issue."));
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
  await callLinear(`move issue ${issueId} to state type "${type}"`, () =>
    linearClient.updateIssue(issueId, { stateId })
  );
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
      await callLinear(`move issue ${issueId} to state "${name}"`, () =>
        linearClient.updateIssue(issueId, { stateId: match.id })
      );
      return true;
    }
  }
  return false;
}

export interface IssueImage {
  mediaType: string;
  base64: string;
}

export interface FullIssueContext {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  comments: string[];
  images: IssueImage[];
}

const IMAGE_EXTENSION_MEDIA_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

// Claude's API rejects images over 5MB (base64-encoded), and we don't want a
// runaway issue description to balloon the prompt — both caps are generous
// for a screenshot/mockup while keeping requests bounded.
const MAX_IMAGES = 10;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** Only download from Linear's own asset hosts — description/comment text is
 * user-authored content, so treating an arbitrary URL in it as fetchable
 * would let anyone with issue-create access make this server issue
 * server-side requests to attacker-controlled hosts. */
function isLinearHostedUrl(url: string): boolean {
  try {
    const { hostname, protocol } = new URL(url);
    return protocol === "https:" && (hostname === "linear.app" || hostname.endsWith(".linear.app"));
  } catch {
    return false;
  }
}

function extractInlineImageUrls(text: string): string[] {
  const urls: string[] = [];
  const pattern = /!\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/g;
  for (const match of text.matchAll(pattern)) {
    urls.push(match[1]);
  }
  return urls;
}

function guessImageMediaType(url: string, contentType: string | null): string | undefined {
  if (contentType) {
    const bare = contentType.split(";")[0]?.trim().toLowerCase();
    if (bare?.startsWith("image/")) return bare;
  }
  const ext = url.split("?")[0].split(".").pop()?.toLowerCase();
  return ext ? IMAGE_EXTENSION_MEDIA_TYPES[ext] : undefined;
}

async function downloadLinearImage(url: string): Promise<IssueImage | undefined> {
  if (!isLinearHostedUrl(url)) return undefined;

  try {
    // Linear's asset storage accepts the same raw API key used for GraphQL
    // requests as the Authorization header for downloading private uploads.
    const response = await fetch(url, { headers: { Authorization: config.linear.apiKey } });
    if (!response.ok) {
      console.log(`Skipping issue image ${url} — download failed with status ${response.status}.`);
      return undefined;
    }

    const mediaType = guessImageMediaType(url, response.headers.get("content-type"));
    if (!mediaType) return undefined; // not an image (e.g. a linked PDF/video attachment)

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > MAX_IMAGE_BYTES) {
      console.log(`Skipping issue image ${url} — exceeds ${MAX_IMAGE_BYTES} byte limit.`);
      return undefined;
    }

    return { mediaType, base64: buffer.toString("base64") };
  } catch (error) {
    console.log(`Skipping issue image ${url} — download error: ${(error as Error).message}`);
    return undefined;
  }
}

/** Collects every image URL worth trying: inline markdown images pasted into
 * the description/comments, plus issue attachments that point at an image
 * file, deduplicated. */
async function collectIssueImageUrls(issue: Awaited<ReturnType<typeof linearClient.issue>>, texts: string[]): Promise<Set<string>> {
  const urls = new Set<string>();
  for (const text of texts) {
    for (const url of extractInlineImageUrls(text)) urls.add(url);
  }

  const attachmentConnection = await callLinear("fetch issue attachments", () => issue.attachments());
  for (const attachment of attachmentConnection.nodes) {
    if (isLinearHostedUrl(attachment.url) && /\.(png|jpe?g|gif|webp)(\?|$)/i.test(attachment.url)) {
      urls.add(attachment.url);
    }
  }

  return urls;
}

/** Fetches an issue plus its discussion comments and images, for handing to Claude as context. */
export async function fetchFullIssueContext(issueId: string): Promise<FullIssueContext> {
  const issue = await callLinear(`fetch issue ${issueId}`, () => linearClient.issue(issueId));
  const commentConnection = await callLinear(`fetch comments for issue ${issueId}`, () => issue.comments());
  const comments = commentConnection.nodes.map((comment) => comment.body);

  const imageUrls = await collectIssueImageUrls(issue, [issue.description ?? "", ...comments]);
  const images: IssueImage[] = [];
  for (const url of imageUrls) {
    if (images.length >= MAX_IMAGES) break;
    const image = await downloadLinearImage(url);
    if (image) images.push(image);
  }

  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description ?? null,
    comments,
    images,
  };
}
