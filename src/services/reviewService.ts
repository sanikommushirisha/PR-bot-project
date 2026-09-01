import { query } from "@anthropic-ai/claude-agent-sdk";
import { simpleGit } from "simple-git";
import type Database from "better-sqlite3";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { config } from "../config/env.js";
import { Jobs, ReviewState } from "../db/index.js";
import { parseRepoSlug, buildCompareUrl } from "./githubService.js";
import { postSlackMessage } from "./slackService.js";

const MAX_DIFF_CHARS = 60_000;

const FINDINGS_SCHEMA = {
  type: "object",
  properties: {
    hasIssues: { type: "boolean" },
    findings: { type: "array", items: { type: "string" } },
  },
  required: ["hasIssues", "findings"],
} as const;

interface ReviewFindings {
  hasIssues: boolean;
  findings: string[];
}

function isReviewFindings(value: unknown): value is ReviewFindings {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as ReviewFindings).hasIssues === "boolean" &&
    Array.isArray((value as ReviewFindings).findings)
  );
}

/**
 * Runs after the queue drains, reviewing everything that changed since the
 * last review checkpoint (not the whole history every time). Posts to Slack
 * only if it finds something genuinely worth a human's attention, and skips
 * entirely if a previous flag is still awaiting a /fix decision.
 */
export async function runBatchReview(db: Database.Database): Promise<void> {
  const chainTip = Jobs.getLastCompletedBranch(db);
  if (!chainTip) return; // nothing has ever completed

  const state = ReviewState.get(db);
  if (state.lastReviewedBranch === chainTip) return; // nothing new since last review

  if (state.pendingFlagFindings) {
    console.log("Batch review skipped — a previous flag is still awaiting a /fix decision.");
    return;
  }

  const fromBranch = state.lastReviewedBranch ?? config.github.baseBranch;
  const { owner, repo } = parseRepoSlug(config.github.slug);

  console.log(`Running batch review: ${fromBranch} -> ${chainTip}`);

  const dir = path.join(config.worker.scratchDir, `review-${Date.now()}`);
  await mkdir(dir, { recursive: true });

  try {
    const remoteUrl = `https://x-access-token:${config.github.auth.token}@github.com/${owner}/${repo}.git`;
    await simpleGit().clone(remoteUrl, dir, ["--branch", chainTip, "--single-branch", "--depth", "100"]);
    const git = simpleGit(dir);

    if (fromBranch !== chainTip) {
      await git.fetch(["origin", `${fromBranch}:refs/remotes/origin/${fromBranch}`]);
    }

    let diff = await git.diff([`origin/${fromBranch}...HEAD`]);
    let truncated = false;
    if (diff.length > MAX_DIFF_CHARS) {
      diff = diff.slice(0, MAX_DIFF_CHARS);
      truncated = true;
    }

    if (!diff.trim()) {
      console.log("Batch review: empty diff, nothing to review.");
      ReviewState.setLastReviewedBranch(db, chainTip);
      return;
    }

    const prompt = [
      "You are reviewing a batch of automated code changes before a human decides whether to open a pull request.",
      "",
      "Below is the cumulative diff of everything that changed in this batch:",
      '"""diff',
      diff,
      truncated ? "\n... (diff truncated for length) ..." : "",
      '"""',
      "",
      "You have read-only access to the full repository at its current state if you need more context beyond the diff — use Read/Glob/Grep, but do not modify anything.",
      "",
      "Flag ONLY genuinely significant concerns: security issues, obviously broken logic, changes that contradict each other or contradict what was likely requested, hardcoded secrets/credentials, or anything a reviewer would clearly want to know about before merging. Do NOT flag style preferences, minor nitpicks, or anything trivial. If there's nothing significant, say so.",
    ].join("\n");

    const stream = query({
      prompt,
      options: {
        cwd: dir,
        env: { ...process.env, ANTHROPIC_API_KEY: config.anthropic.apiKey },
        permissionMode: "default",
        allowedTools: ["Read", "Glob", "Grep"],
        settingSources: ["project"],
        maxTurns: 20,
        outputFormat: { type: "json_schema", schema: FINDINGS_SCHEMA },
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          append: "You are running unattended as a read-only code reviewer. You must not edit any files or run any commands that change state.",
        },
      },
    });

    let structuredOutput: unknown;
    let isError = true;
    for await (const message of stream) {
      if (message.type !== "result") continue;
      isError = message.is_error;
      if (message.subtype === "success") {
        structuredOutput = message.structured_output;
      }
    }

    ReviewState.setLastReviewedBranch(db, chainTip);

    if (isError || !isReviewFindings(structuredOutput)) {
      console.error("Batch review did not complete successfully or returned unexpected output.");
      return;
    }

    if (!structuredOutput.hasIssues || structuredOutput.findings.length === 0) {
      console.log("Batch review: no significant issues found.");
      return;
    }

    const compareUrl = buildCompareUrl(owner, repo, config.github.baseBranch, chainTip);
    const text = [
      `⚠️ Review of the completed batch (${fromBranch} → ${chainTip}) flagged something worth a look:`,
      "",
      ...structuredOutput.findings.map((f) => `• ${f}`),
      "",
      `Compare: ${compareUrl}`,
      "Reply with `/fix` if you'd like the agent to address these before you open the PR.",
    ].join("\n");

    const messageTs = await postSlackMessage(config.slack.allowedChannelId, text);
    ReviewState.setPendingFlag(db, structuredOutput.findings.join("\n"), messageTs ?? null);
  } catch (err) {
    console.error("Batch review failed:", err);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
