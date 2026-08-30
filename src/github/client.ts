import { Octokit } from "@octokit/rest";
import type { GithubAuthConfig } from "../config/index.js";

/**
 * Only `pat` is implemented today. Swapping to a GitHub App later means
 * adding an `"app"` branch here (via `@octokit/auth-app`) and changing
 * `config.github.auth` — no calling code needs to change.
 */
export function createOctokit(auth: GithubAuthConfig): Octokit {
  switch (auth.type) {
    case "pat":
      return new Octokit({ auth: auth.token });
    default:
      throw new Error(`Unsupported GitHub auth type: ${(auth as { type: string }).type}`);
  }
}

export function buildAuthenticatedRemoteUrl(owner: string, repo: string, token: string): string {
  return `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;
}
