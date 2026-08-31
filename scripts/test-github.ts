import { writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "../src/config/index.js";
import { createOctokit } from "../src/github/client.js";
import { cloneRepo, createBranch, commitAll, pushBranch, cleanupClone } from "../src/github/repo.js";
import { createDraftPullRequest } from "../src/github/pr.js";
import { buildBranchName } from "../src/github/slug.js";

async function main() {
  const jobId = Date.now();
  const branchName = buildBranchName("standalone github module test", jobId);

  console.log(`Cloning ${config.github.slug}@${config.github.baseBranch}...`);
  const { git, dir } = await cloneRepo({
    owner: config.github.owner,
    repo: config.github.repo,
    token: config.github.auth.token,
    baseBranch: config.github.baseBranch,
    scratchDir: config.worker.scratchDir,
    jobId,
  });
  console.log(`Cloned to ${dir}`);

  await createBranch(git, branchName);
  console.log(`Created branch ${branchName}`);

  const testFile = path.join(dir, "AGENT_BRIDGE_TEST.md");
  await writeFile(
    testFile,
    `# slack-agent-bridge test\n\nGenerated at ${new Date().toISOString()}. Safe to delete/close.\n`
  );

  await commitAll(git, `test: verify github module (job ${jobId})`);
  await pushBranch(git, branchName);
  console.log(`Pushed ${branchName}`);

  const octokit = createOctokit(config.github.auth);
  const prUrl = await createDraftPullRequest({
    octokit,
    owner: config.github.owner,
    repo: config.github.repo,
    base: config.github.baseBranch,
    head: branchName,
    title: "[test] slack-agent-bridge github module",
    body: "Standalone test of the github module (clone, branch, commit, push, draft PR). Safe to close.",
  });

  console.log(`Draft PR opened: ${prUrl}`);

  await cleanupClone(dir);
  console.log("Local scratch clone cleaned up.");
}

main().catch((err) => {
  console.error("test-github failed:", err);
  process.exit(1);
});
