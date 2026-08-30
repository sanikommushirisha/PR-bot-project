import { query } from "@anthropic-ai/claude-agent-sdk";
import { buildTaskPrompt, type TaskPromptContext } from "./prompt.js";

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
      allowedTools: ["Read", "Edit", "Write", "Glob", "Grep", "Bash"],
      maxTurns: params.maxTurns ?? 40,
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append:
          "You are running unattended as part of an automated Telegram-to-PR pipeline. Never run git commit, git push, or open a pull request yourself — a separate deterministic process handles all git/GitHub actions after you finish.",
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
