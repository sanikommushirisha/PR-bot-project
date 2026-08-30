import { promises as fs } from "node:fs";
import path from "node:path";
import { simpleGit, type SimpleGit } from "simple-git";

export interface CloneOptions {
  cloneUrl: string;
  /** Absolute path the repo should be cloned into. Created if missing. */
  dir: string;
  /** `AUTHORIZATION: basic <base64>` header from getGitAuthHeader(), or undefined for public/local repos. */
  authHeader?: string;
  /** Branch to check out after cloning (defaults to the remote's default branch). */
  checkoutBranch?: string;
}

/**
 * Fresh clone into a per-job scratch directory (as opposed to a single
 * persistent clone reused across jobs + `fetch`/`checkout`).
 *
 * Tradeoff: a fresh clone is slower for large repos (no shared object cache
 * between jobs) but keeps every job fully isolated -- no risk of one job's
 * half-finished checkout leaking into another's, and no locking needed
 * around a shared working directory when jobs run concurrently. Given the
 * worker can process multiple jobs at once, isolation wins by default here.
 * If repo size becomes a real bottleneck, switch to a persistent bare clone
 * per repo (`git clone --bare`) with each job doing `git worktree add` off
 * it -- that keeps isolation while sharing the object store.
 */
export async function prepareRepoWorkdir(opts: CloneOptions): Promise<SimpleGit> {
  await fs.rm(opts.dir, { recursive: true, force: true });
  await fs.mkdir(opts.dir, { recursive: true });

  // A *global* -c (before the `clone` subcommand) only affects this one git
  // invocation -- unlike `git clone -c k=v`, which writes k=v into the new
  // repo's .git/config. Using the global form means the token never touches
  // disk in the clone, only the process argv for this one command.
  const args: string[] = [];
  if (opts.authHeader) {
    args.push("-c", `http.extraHeader=${opts.authHeader}`);
  }
  args.push("clone");
  if (opts.checkoutBranch) {
    args.push("--branch", opts.checkoutBranch);
  }
  args.push(opts.cloneUrl, opts.dir);

  const git = simpleGit();
  await git.raw(args);

  return simpleGit(opts.dir);
}

export async function createBranch(git: SimpleGit, branchName: string): Promise<void> {
  await git.checkoutLocalBranch(branchName);
}

/**
 * Stages everything and commits. Returns false (no commit made) if the
 * working tree was already clean -- callers should treat that as "the agent
 * produced no changes" rather than pushing an empty branch.
 */
export async function commitAll(git: SimpleGit, message: string): Promise<boolean> {
  await git.add(["-A"]);
  const status = await git.status();
  if (status.files.length === 0) {
    return false;
  }
  await git.commit(message);
  return true;
}

export async function pushBranch(git: SimpleGit, branchName: string, authHeader: string | undefined): Promise<void> {
  const args = ["push", "--set-upstream", "origin", branchName];
  if (authHeader) {
    await git.raw(["-c", `http.extraHeader=${authHeader}`, ...args]);
  } else {
    await git.raw(args);
  }
}

export async function cleanupWorkdir(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}

export function scratchDirFor(baseScratchDir: string, jobId: string): string {
  return path.join(baseScratchDir, jobId);
}
