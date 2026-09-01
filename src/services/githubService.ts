import { simpleGit, type SimpleGit } from "simple-git";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { config } from "../config/env.js";

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
  baseBranch: string;
  issueIdentifier: string;
}): Promise<CloneResult> {
  const dir = path.join(config.worker.scratchDir, `${params.issueIdentifier}-${Date.now()}`);
  await mkdir(dir, { recursive: true });

  const remoteUrl = buildAuthenticatedRemoteUrl(params.owner, params.repo, config.github.auth.token);
  await simpleGit().clone(remoteUrl, dir, [
    "--branch",
    params.baseBranch,
    "--single-branch",
    "--depth",
    "50",
  ]);

  const git = simpleGit(dir);
  await git.addConfig("user.name", "slack-linear-claude-agent");
  await git.addConfig("user.email", "agent-bridge@users.noreply.github.com");

  return { git, dir };
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
  await git.push(["-u", "origin", branchName]);
}

export async function cleanupClone(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}
