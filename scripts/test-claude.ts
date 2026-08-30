import { config } from "../src/config/index.js";
import { runAgentTask } from "../src/claude/session.js";

async function main() {
  const [cwd, ...rest] = process.argv.slice(2);
  if (!cwd) {
    console.error("Usage: pnpm test:claude -- <path-to-local-repo-checkout> [task description]");
    process.exit(1);
  }

  const taskDescription =
    rest.join(" ") || "Add a CONTRIBUTING.md file with a one-paragraph note on how to run tests.";

  console.log(`Running agent task against ${cwd}`);
  console.log(`Task: ${taskDescription}`);
  console.log("---");

  const result = await runAgentTask({
    cwd,
    taskDescription,
    requestingUsername: "standalone-test-script",
    anthropicApiKey: config.anthropic.apiKey,
  });

  console.log("---");
  console.log(`Success: ${result.success}`);
  console.log(`Turns: ${result.turns}`);
  if (result.costUsd !== undefined) console.log(`Cost: $${result.costUsd.toFixed(4)}`);
  console.log("Summary:");
  console.log(result.summary);

  if (!result.success) process.exit(1);
}

main().catch((err) => {
  console.error("test-claude failed:", err);
  process.exit(1);
});
