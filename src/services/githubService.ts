import { simpleGit, type SimpleGit } from "simple-git";
import { mkdir, readdir, rm } from "node:fs/promises";
import { exec as execCallback } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { createOctokit } from "../config/clients.js";
import { config } from "../config/env.js";
import { toIntegrationError } from "../errors/integrationError.js";

const exec = promisify(execCallback);

/** Wraps a GitHub-bound call (git over HTTPS, or the REST API) so any failure surfaces on the dashboard tagged as a GitHub integration error. */
async function callGithub<T>(context: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw toIntegrationError("github", context, err);
  }
}

export interface RepoSlug {
  owner: string;
  repo: string;
}

export function parseRepoSlug(slug: string): RepoSlug {
  const [owner, repo] = slug.split("/");
  if (!owner || !repo) {
    throw new Error(`Invalid repo slug "${slug}", expected "owner/repo"`);
  }
  return { owner, repo };
}

export function slugifyTask(description: string, maxLength = 40): string {
  const slug = description
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength)
    .replace(/-+$/g, "");
  return slug || "task";
}

/** Includes a timestamp so re-triggering the same issue (e.g. moving it back to the trigger state to retry) never collides with a branch already pushed by a previous run. */
export function buildBranchName(taskDescription: string, issueIdentifier: string): string {
  return `agent/${slugifyTask(taskDescription)}-${issueIdentifier.toLowerCase()}-${Date.now()}`;
}

/** GitHub's compare view works for any two refs without needing a PR to exist yet. */
export function buildCompareUrl(owner: string, repo: string, base: string, head: string): string {
  return `https://github.com/${owner}/${repo}/compare/${base}...${head}`;
}

function buildAuthenticatedRemoteUrl(owner: string, repo: string, token: string): string {
  return `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;
}

export interface CloneResult {
  git: SimpleGit;
  dir: string;
}

export async function cloneRepo(params: {
  owner: string;
  repo: string;
  branch: string;
  workDirName: string;
}): Promise<CloneResult> {
  const dir = path.join(config.worker.scratchDir, `${params.workDirName}-${Date.now()}`);
  await mkdir(dir, { recursive: true });

  const remoteUrl = buildAuthenticatedRemoteUrl(params.owner, params.repo, config.github.auth.token);
  await callGithub(`clone ${params.owner}/${params.repo}#${params.branch}`, () =>
    simpleGit().clone(remoteUrl, dir, ["--branch", params.branch, "--single-branch", "--depth", "50"])
  );

  const git = simpleGit(dir);
  await git.addConfig("user.name", "slack-linear-claude-agent");
  await git.addConfig("user.email", "agent-bridge@users.noreply.github.com");

  return { git, dir };
}

const INSTALL_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Installs the freshly-cloned repo's dependencies, including
 * devDependencies, before the agent starts working. Two things this
 * guards against:
 *  - Without this, whether node_modules exists at all depended entirely on
 *    the agent deciding to run its own install mid-session — some jobs
 *    never did, so the target repo's own pre-push typecheck hook (wired up
 *    by its "prepare" script the moment *any* install runs) silently never
 *    got a chance to run at all.
 *  - This process runs under NODE_ENV=production (ecosystem.config.cjs),
 *    and npm's default behavior there is to skip devDependencies entirely.
 *    Explicitly overriding it here — matching the same override made for
 *    the agent's own env in claudeService.ts — is what actually makes
 *    `npm install` behave like a normal developer checkout.
 * Uses `npm` specifically because that's this target repo's own declared
 * package manager (its package.json pins "packageManager": "npm@...").
 */
export async function installDependencies(dir: string): Promise<void> {
  try {
    await exec("npm install", {
      cwd: dir,
      timeout: INSTALL_TIMEOUT_MS,
      maxBuffer: 20 * 1024 * 1024,
      env: { ...process.env, NODE_ENV: "development" },
    });
  } catch (err) {
    const std = err && typeof err === "object" ? (err as { stdout?: string; stderr?: string }) : {};
    const output = [std.stdout, std.stderr].filter(Boolean).join("\n").slice(-4000);
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`npm install failed: ${message}${output ? `\n${output}` : ""}`);
  }
}

export async function createBranch(git: SimpleGit, branchName: string): Promise<void> {
  await git.checkoutLocalBranch(branchName);
}

export async function hasChanges(git: SimpleGit): Promise<boolean> {
  const status = await git.status();
  return !status.isClean();
}

export async function commitAll(git: SimpleGit, message: string): Promise<void> {
  await git.add(["-A"]);
  await git.commit(message);
}

export async function pushBranch(git: SimpleGit, branchName: string): Promise<void> {
  await callGithub(`push branch ${branchName}`, () => git.push(["-u", "origin", branchName]));
}

export async function cleanupClone(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

/**
 * Removes every leftover clone directory under the scratch dir. A live job
 * always cleans up its own dir in `processJob`'s `finally` block before this
 * process could restart, so anything still present at startup was orphaned
 * by a crash or a restart mid-job — left behind forever otherwise, silently
 * filling the disk (a multi-GB clone per interrupted job) until writes start
 * failing across the whole app.
 */
export async function cleanupStaleScratchDirs(scratchDir: string): Promise<{ removed: number }> {
  const entries = await readdir(scratchDir, { withFileTypes: true });
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    await rm(path.join(scratchDir, entry.name), { recursive: true, force: true });
    removed++;
  }
  return { removed };
}

export async function createDraftPullRequest(params: {
  owner: string;
  repo: string;
  base: string;
  head: string;
  title: string;
  body: string;
}): Promise<{ url: string; number: number }> {
  const octokit = createOctokit(config.github.auth);
  const { data } = await callGithub(`create draft PR ${params.owner}/${params.repo} ${params.head} -> ${params.base}`, () =>
    octokit.pulls.create({
      owner: params.owner,
      repo: params.repo,
      base: params.base,
      head: params.head,
      title: params.title,
      body: params.body,
      draft: true,
    })
  );
  return { url: data.html_url, number: data.number };
}

export interface PullRequestStatus {
  number: number;
  url: string;
  title: string;
  isDraft: boolean;
  state: "open" | "closed";
  merged: boolean;
  /** null while GitHub is still computing mergeability. */
  mergeableState: string | null;
  reviewDecision: "approved" | "changes_requested" | "review_required" | "none";
  checksState: "success" | "failure" | "pending" | "none";
  updatedAt: string;
}

/** Latest review per reviewer wins — an earlier CHANGES_REQUESTED that was since re-approved shouldn't still block. */
function summarizeReviewDecision(
  reviews: { user: { login: string } | null; state: string; submitted_at?: string }[]
): PullRequestStatus["reviewDecision"] {
  const latestByReviewer = new Map<string, string>();
  for (const review of reviews) {
    const login = review.user?.login;
    if (!login || !review.submitted_at) continue;
    latestByReviewer.set(login, review.state);
  }
  const states = [...latestByReviewer.values()];
  if (states.length === 0) return "review_required";
  if (states.includes("CHANGES_REQUESTED")) return "changes_requested";
  if (states.includes("APPROVED")) return "approved";
  return "review_required";
}

function summarizeChecksState(
  checkRuns: { status: string; conclusion: string | null }[]
): PullRequestStatus["checksState"] {
  if (checkRuns.length === 0) return "none";
  const failing = new Set(["failure", "timed_out", "cancelled", "action_required"]);
  if (checkRuns.some((run) => run.conclusion && failing.has(run.conclusion))) return "failure";
  if (checkRuns.some((run) => run.status !== "completed")) return "pending";
  return "success";
}

/** Finds the PR (if any) opened from the given branch and summarizes the signals the dashboard needs — draft state, review decision, and check status. Returns null if no PR was ever opened for this branch. */
export async function findPullRequestForBranch(
  owner: string,
  repo: string,
  branch: string
): Promise<PullRequestStatus | null> {
  const octokit = createOctokit(config.github.auth);

  const { data: matches } = await callGithub(`list PRs for ${owner}/${repo}#${branch}`, () =>
    octokit.pulls.list({
      owner,
      repo,
      head: `${owner}:${branch}`,
      state: "all",
      per_page: 1,
    })
  );
  const match = matches[0];
  if (!match) return null;

  const [{ data: pr }, { data: reviews }, { data: checks }] = await callGithub(
    `fetch PR #${match.number} status for ${owner}/${repo}`,
    () =>
      Promise.all([
        octokit.pulls.get({ owner, repo, pull_number: match.number }),
        octokit.pulls.listReviews({ owner, repo, pull_number: match.number }),
        octokit.checks.listForRef({ owner, repo, ref: branch }),
      ])
  );

  return {
    number: pr.number,
    url: pr.html_url,
    title: pr.title,
    isDraft: pr.draft ?? false,
    state: pr.state as "open" | "closed",
    merged: pr.merged,
    mergeableState: pr.mergeable_state ?? null,
    reviewDecision: summarizeReviewDecision(reviews),
    checksState: summarizeChecksState(checks.check_runs),
    updatedAt: pr.updated_at,
  };
}
