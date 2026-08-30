/**
 * Standalone smoke test for src/github/*, run against a REAL repo before any
 * Telegram/Claude wiring exists. This will actually push a branch and open a
 * draft PR -- point it at a scratch/test repo you own, not anything shared.
 *
 * Usage:
 *   pnpm test:github [owner/repo] [baseBranch]
 * Falls back to GITHUB_DEFAULT_REPO / GITHUB_DEFAULT_BASE_BRANCH from .env.
 */
import path from "node:path";
import { nanoid } from "nanoid";
import { env, resolveGithubAuth } from "../src/config/index.js";
import {
  buildCloneUrl,
  buildBranchName,
  cleanupWorkdir,
  commitAll,
  createBranch,
  createDraftPullRequest,
  createOctokit,
  getGitAuthHeader,
  prepareRepoWorkdir,
  pushBranch,
  scratchDirFor,
  splitOwnerRepo,
} from "../src/github/index.js";
import { promises as fs } from "node:fs";

async function main() {
  const targetRepo = process.argv[2] ?? env.GITHUB_DEFAULT_REPO;
  const baseBranch = process.argv[3] ?? env.GITHUB_DEFAULT_BASE_BRANCH;
  const { owner, repo } = splitOwnerRepo(targetRepo);

  const jobId = nanoid(8);
  const branchName = buildBranchName("github module smoke test", jobId);
  const dir = path.resolve(scratchDirFor(env.WORKER_SCRATCH_DIR, jobId));

  console.log(`[test-github] repo=${targetRepo} base=${baseBranch} branch=${branchName}`);
  console.log(`[test-github] scratch dir: ${dir}`);

  const auth = resolveGithubAuth();
  const authHeader = await getGitAuthHeader(auth);
  const cloneUrl = buildCloneUrl(owner, repo);

  let cleanedUp = false;
  try {
    console.log("[test-github] cloning...");
    const git = await prepareRepoWorkdir({ cloneUrl, dir, authHeader, checkoutBranch: baseBranch });

    console.log(`[test-github] creating branch ${branchName}...`);
    await createBranch(git, branchName);

    const markerPath = path.join(dir, "AGENT_TEST_LOG.md");
    const line = `- telegram-agent-bridge github-module smoke test at ${new Date().toISOString()} (job ${jobId})\n`;
    await fs.appendFile(markerPath, line, "utf8");

    console.log("[test-github] committing...");
    const committed = await commitAll(git, `test: github module smoke test (job ${jobId})`);
    if (!committed) {
      throw new Error("Expected a change to commit but working tree was clean");
    }

    console.log("[test-github] pushing...");
    await pushBranch(git, branchName, authHeader);

    console.log("[test-github] opening draft PR...");
    const octokit = createOctokit(auth);
    const pr = await createDraftPullRequest({
      octokit,
      owner,
      repo,
      base: baseBranch,
      head: branchName,
      title: `[test] github module smoke test (${jobId})`,
      telegramRequestText: "(this is a standalone test run, not a real Telegram request)",
      telegramMessageLink: "https://t.me/c/TEST/TEST",
    });

    console.log(`[test-github] SUCCESS: ${pr.url}`);
  } finally {
    await cleanupWorkdir(dir);
    cleanedUp = true;
    console.log(`[test-github] cleaned up scratch dir (${cleanedUp})`);
  }
}

main().catch((err) => {
  console.error("[test-github] FAILED:", err);
  process.exit(1);
});
