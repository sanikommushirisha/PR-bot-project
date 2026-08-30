export interface TaskPromptContext {
  taskDescription: string;
  requestingUsername: string | null;
  chatContextNote?: string | null;
}

export function buildTaskPrompt(ctx: TaskPromptContext): string {
  const lines = [
    "You are working inside a git checkout of a repository, on a fresh branch created for this task.",
    "",
    `Task requested via Telegram by ${ctx.requestingUsername ?? "a user"}:`,
    '"""',
    ctx.taskDescription,
    '"""',
  ];

  if (ctx.chatContextNote) {
    lines.push("", "Additional context (the message this request was replied to):", ctx.chatContextNote);
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
