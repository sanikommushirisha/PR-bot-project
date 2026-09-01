import { query } from "@anthropic-ai/claude-agent-sdk";
import { guardAgentTool } from "./claudeSecurity.js";
import { config } from "../config/env.js";
import type { FullIssueContext } from "./linearService.js";

export interface AgentRunResult {
  success: boolean;
  summary: string;
  turns: number;
  costUsd: number | undefined;
}

function buildTaskPrompt(issue: FullIssueContext): string {
  const lines = [
    "You are working inside a git checkout of a repository, on a fresh branch created for this task.",
    "",
    `Linear issue ${issue.identifier}: ${issue.title}`,
    '"""',
    issue.description ?? "(no description)",
    '"""',
  ];

  if (issue.comments.length > 0) {
    lines.push("", "Discussion comments on the issue, oldest first:");
    issue.comments.forEach((comment, i) => lines.push(`${i + 1}. ${comment}`));
  }

  lines.push(
    "",
    "Instructions:",
    "- Make the code changes needed to complete the task.",
    "- Run any available tests and linters for the parts of the codebase you touched, and fix failures you introduce.",
    "- Do NOT run `git commit`, `git push`, or create a pull request. Leave your changes uncommitted in the working tree — a separate deterministic process handles all git and GitHub operations after you finish.",
    "- Do NOT modify git config or remotes, and do NOT switch branches.",
    "- When you are done, give a concise final summary of what you changed and why."
  );

  return lines.join("\n");
}

export async function runAgentTask(cwd: string, issue: FullIssueContext): Promise<AgentRunResult> {
  const prompt = buildTaskPrompt(issue);

  const stream = query({
    prompt,
    options: {
      cwd,
      env: { ...process.env, ANTHROPIC_API_KEY: config.anthropic.apiKey },
      // 'acceptEdits' auto-approves Write/Edit through a path that bypasses
      // canUseTool entirely, regardless of allowedTools — confirmed by
      // direct testing (it silently let a canUseTool-denied file write
      // through to disk). 'default' is what actually routes every
      // Write/Edit/Bash decision through canUseTool below.
      permissionMode: "default",
      // Bash, Write, and Edit are deliberately left out of allowedTools
      // (which bypasses permission checks entirely) so every invocation of
      // them is forced through canUseTool below and checked against the
      // deny rules (Bash commands, and Write/Edit targeting a CI pipeline
      // definition file). Read/Glob/Grep are read-only and unrestricted.
      allowedTools: ["Read", "Glob", "Grep"],
      canUseTool: guardAgentTool,
      // Without this, the SDK runs in full isolation and ignores the target
      // repo's own CLAUDE.md and .claude/settings.json entirely. 'project'
      // only pulls in repo-local settings from the clone — not 'user'.
      settingSources: ["project"],
      maxTurns: 40,
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append:
          "You are running unattended as part of an automated Linear-to-PR pipeline. Never run git commit, git push, or open a pull request yourself — a separate deterministic process handles all git/GitHub actions after you finish.",
      },
    },
  });

  let isError = true;
  let summary = "Agent produced no final result message.";
  let turns = 0;
  let costUsd: number | undefined;

  for await (const message of stream) {
    if (message.type !== "result") continue;

    isError = message.is_error;
    turns = message.num_turns;
    costUsd = message.total_cost_usd;
    summary = message.subtype === "success" ? message.result : message.errors.join("; ");
  }

  return { success: !isError, summary, turns, costUsd };
}
