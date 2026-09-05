import type Database from "better-sqlite3";
import { query, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { guardAgentTool } from "./claudeSecurity.js";
import { config } from "../config/env.js";
import type { FullIssueContext } from "./linearService.js";
import { ActivityLogs } from "../db/activityLogs.js";
import { toIntegrationError } from "../errors/integrationError.js";

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

function truncate(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

function stringifyToolInput(input: unknown): string {
  try {
    return truncate(JSON.stringify(input), 200);
  } catch {
    return "(unserializable input)";
  }
}

/** Extracts a short human-readable preview from a tool_result block's content, which is either a plain string or a list of content blocks (usually text). */
function previewToolResultContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => (block && typeof block === "object" && "text" in block ? String((block as { text: unknown }).text) : `[${(block as { type?: string })?.type ?? "content"}]`))
      .join(" ");
  }
  return "";
}

function logInfo(db: Database.Database, jobId: number, message: string): void {
  if (!message.trim()) return;
  ActivityLogs.insert(db, { jobId, source: "claude", level: "info", message });
}

/** Turns one message from the agent's live stream into zero or more log
 * lines for the dashboard's "live activity" view — mirrors what you'd see
 * scrolling by in a terminal running Claude Code interactively. */
function logStreamMessage(db: Database.Database, jobId: number, message: SDKMessage): void {
  if (message.type === "system" && message.subtype === "init") {
    logInfo(db, jobId, `Session started (model: ${message.model}).`);
    return;
  }

  if (message.type === "assistant") {
    for (const block of message.message.content) {
      if (block.type === "text") {
        logInfo(db, jobId, block.text);
      } else if (block.type === "tool_use") {
        logInfo(db, jobId, `→ ${block.name}(${stringifyToolInput(block.input)})`);
      }
    }
    return;
  }

  if (message.type === "user" && Array.isArray(message.message.content)) {
    for (const block of message.message.content) {
      if (block.type === "tool_result") {
        const preview = truncate(previewToolResultContent(block.content), 300) || "(no output)";
        logInfo(db, jobId, `${block.is_error ? "✗" : "✓"} ${preview}`);
      }
    }
    return;
  }

  if (message.type === "result") {
    if (message.subtype === "success") {
      logInfo(db, jobId, "Task finished.");
    } else {
      // A real Claude-side failure (max turns/budget hit, execution error) —
      // worth surfacing on the integration-errors view, not just the live feed.
      ActivityLogs.insert(db, {
        jobId,
        source: "claude",
        level: "error",
        message: `Agent run ended in error (${message.subtype}): ${message.errors.join("; ")}`,
      });
    }
  }
}

export async function runAgentTask(
  cwd: string,
  issue: FullIssueContext,
  jobId: number,
  db: Database.Database
): Promise<AgentRunResult> {
  const content = buildPromptContent(issue);
  const prompt = typeof content === "string" ? content : toPromptStream(content);

  // The SDK ignores the Claude Code subprocess's stderr by default (only
  // captured here, or under DEBUG_CLAUDE_AGENT_SDK) — without this, a
  // subprocess crash surfaces as nothing but "Claude Code process exited
  // with code 1" on the dashboard, with the real reason (rate limit,
  // auth failure, OOM, ...) silently discarded. Buffer the tail of it so
  // it can be attached to the thrown error below.
  let stderrTail = "";
  const MAX_STDERR_TAIL = 4000;

  const stream = query({
    prompt,
    options: {
      cwd,
      stderr: (data: string) => {
        stderrTail = (stderrTail + data).slice(-MAX_STDERR_TAIL);
      },
      // This process runs under NODE_ENV=production (ecosystem.config.cjs).
      // Left as-is, that inherits straight into the agent's own shell — and
      // npm's default behavior under NODE_ENV=production is to silently skip
      // devDependencies on `npm install`, which is exactly the class of bug
      // that made the target repo's pre-push typecheck hook fail with
      // dozens of "Cannot find module 'vitest'" errors. The agent's install
      // should behave like a normal developer checkout, not inherit this
      // process's own runtime mode.
      env: { ...process.env, NODE_ENV: "development", ANTHROPIC_API_KEY: config.anthropic.apiKey },
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
          "You are running unattended as part of an automated Linear-to-PR pipeline. Never run git commit, git push, or open a pull request yourself — a separate deterministic process handles all git/GitHub actions after you finish. Dependencies are already installed (npm install ran before you started) — no need to run it yourself unless you add a new package. " +
          "Nobody is watching this session in real time, so if the task is genuinely ambiguous or you're missing information you'd normally ask about, do not guess and do not make speculative changes: stop, and make your final message a clear, specific question stating exactly what you need clarified. That question is surfaced back to the person who filed the task — it is not lost — and they can answer it as a comment on the Linear issue and re-run the task.",
      },
    },
  });

  let isError = true;
  let summary = "Agent produced no final result message.";
  let turns = 0;
  let costUsd: number | undefined;

  try {
    for await (const message of stream) {
      logStreamMessage(db, jobId, message);
      if (message.type !== "result") continue;

      isError = message.is_error;
      turns = message.num_turns;
      costUsd = message.total_cost_usd;
      summary = message.subtype === "success" ? message.result : message.errors.join("; ");
    }
  } catch (err) {
    // The SDK subprocess/transport itself failed (e.g. couldn't reach the
    // Anthropic API, or crashed) — distinct from a completed-but-unsuccessful
    // run, which is reported via the 'result' message above instead. Append
    // whatever stderr the process printed on its way out, since the SDK's
    // own error carries only the exit code.
    const detail = stderrTail.trim();
    const context = detail ? `Agent stream failed (stderr: ${truncate(detail, 1000)})` : "Agent stream failed";
    throw toIntegrationError("claude", context, err);
  }

  return { success: !isError, summary, turns, costUsd };
}
