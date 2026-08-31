import { query } from "@anthropic-ai/claude-agent-sdk";
import { buildTaskPrompt, type TaskPromptContext } from "./prompt.js";
import { guardBashTool } from "./security.js";

export interface RunAgentTaskParams extends TaskPromptContext {
  cwd: string;
  anthropicApiKey: string;
  maxTurns?: number;
}

export interface AgentRunResult {
  success: boolean;
  summary: string;
  turns: number;
  costUsd: number | undefined;
}

export async function runAgentTask(params: RunAgentTaskParams): Promise<AgentRunResult> {
  const prompt = buildTaskPrompt(params);

  const stream = query({
    prompt,
    options: {
      cwd: params.cwd,
      env: { ...process.env, ANTHROPIC_API_KEY: params.anthropicApiKey },
      permissionMode: "acceptEdits",
      // Bash is deliberately left out of allowedTools (which bypasses
      // permission checks entirely) so every invocation is forced through
      // canUseTool below and checked against the deny patterns.
      allowedTools: ["Read", "Edit", "Write", "Glob", "Grep"],
      canUseTool: guardBashTool,
      // Without this, the SDK runs in full isolation and ignores the target
      // repo's own CLAUDE.md and .claude/settings.json entirely. 'project'
      // only pulls in repo-local settings from the clone — not 'user', which
      // would pull in this host's own ~/.claude settings.
      settingSources: ["project"],
      maxTurns: params.maxTurns ?? 40,
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append:
          "You are running unattended as part of an automated Slack-to-PR pipeline. Never run git commit, git push, or open a pull request yourself — a separate deterministic process handles all git/GitHub actions after you finish.",
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
