import { WebClient } from "@slack/web-api";
import { LinearClient } from "@linear/sdk";
import { Octokit } from "@octokit/rest";
import { config } from "./env.js";
import type { GithubAuthConfig } from "./env.js";

export const slackClient = new WebClient(config.slack.botToken);

export const linearClient = new LinearClient({ apiKey: config.linear.apiKey });

/**
 * Only `pat` is implemented today. Swapping to a GitHub App later means
 * adding an `"app"` branch here (via `@octokit/auth-app`) — no calling code
 * needs to change since `config.github.auth` is already a discriminated union.
 */
export function createOctokit(auth: GithubAuthConfig): Octokit {
  switch (auth.type) {
    case "pat":
      return new Octokit({ auth: auth.token });
    default:
      throw new Error(`Unsupported GitHub auth type: ${(auth as { type: string }).type}`);
  }
}
