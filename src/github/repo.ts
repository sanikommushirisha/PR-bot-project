import { simpleGit, type SimpleGit } from "simple-git";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { buildAuthenticatedRemoteUrl } from "./client.js";

export interface CloneParams {
  owner: string;
  repo: string;
  token: string;
  baseBranch: string;
  scratchDir: string;
  jobId: number;
}

export interface CloneResult {
  git: SimpleGit;
  dir: string;
}

export async function cloneRepo(params: CloneParams): Promise<CloneResult> {
  const dir = path.join(params.scratchDir, `job-${params.jobId}-${Date.now()}`);
  await mkdir(dir, { recursive: true });

  const remoteUrl = buildAuthenticatedRemoteUrl(params.owner, params.repo, params.token);
  await simpleGit().clone(remoteUrl, dir, [
    "--branch",
    params.baseBranch,
    "--single-branch",
    "--depth",
    "50",
  ]);

  const git = simpleGit(dir);
  await git.addConfig("user.name", "slack-agent-bridge");
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
