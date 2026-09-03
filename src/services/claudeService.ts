import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { guardAgentTool } from "./claudeSecurity.js";
import { config } from "../config/env.js";
import type { FullIssueContext } from "./linearService.js";

type PromptContent = SDKUserMessage["message"]["content"];

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

  if (issue.images.length > 0) {
    lines.push(
      "",
      `${issue.images.length} image(s) from the issue/comments are attached below this message — refer to them as needed.`
    );
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

function buildPromptContent(issue: FullIssueContext): PromptContent {
  const text = buildTaskPrompt(issue);
  if (issue.images.length === 0) return text;

  return [
    { type: "text", text },
    ...issue.images.map((image) => ({
      type: "image" as const,
      source: { type: "base64" as const, media_type: image.mediaType, data: image.base64 },
    })),
  ] as PromptContent;
}

/** The SDK accepts either a plain string prompt or a stream of user messages
 * — a stream is required to attach image content blocks, so we wrap a
 * single message in a one-shot async generator when images are present. */
async function* toPromptStream(content: PromptContent): AsyncGenerator<SDKUserMessage> {
  yield {
    type: "user",
    session_id: "",
    message: { role: "user", content },
    parent_tool_use_id: null,
  };
}

export async function runAgentTask(cwd: string, issue: FullIssueContext): Promise<AgentRunResult> {
  const content = buildPromptContent(issue);
  const prompt = typeof content === "string" ? content : toPromptStream(content);

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
