import { Octokit } from "@octokit/rest";
import { createAppAuth } from "@octokit/auth-app";
import { type GithubAuthConfig, resolveGithubAuth } from "../config/index.js";

/**
 * Octokit instance for REST calls (PR creation, comments, etc). For GitHub
 * App auth, passing `authStrategy` lets Octokit fetch and transparently
 * refresh installation tokens itself, so we don't manage token expiry here.
 */
export function createOctokit(auth: GithubAuthConfig = resolveGithubAuth()): Octokit {
  if (auth.kind === "pat") {
    return new Octokit({ auth: auth.token });
  }
  return new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: auth.appId,
      privateKey: auth.privateKey,
      installationId: auth.installationId,
    },
  });
}

/**
 * Raw bearer token for git-over-HTTPS operations (clone/push), as opposed to
 * the Octokit REST client above. GitHub Apps and PATs are both accepted by
 * git's HTTP transport as `x-access-token:<token>` basic auth.
 */
async function getRawGitToken(auth: GithubAuthConfig): Promise<string> {
  if (auth.kind === "pat") {
    return auth.token;
  }
  const appAuth = createAppAuth({ appId: auth.appId, privateKey: auth.privateKey });
  const installationAuth = await appAuth({
    type: "installation",
    installationId: Number(auth.installationId),
  });
  return installationAuth.token;
}

/**
 * Builds a `http.extraHeader` value for git so the token is passed per-request
 * instead of being embedded in the remote URL (which would otherwise persist
 * in plaintext in the scratch clone's .git/config for the job's lifetime).
 */
export async function getGitAuthHeader(auth: GithubAuthConfig = resolveGithubAuth()): Promise<string> {
  const token = await getRawGitToken(auth);
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  return `AUTHORIZATION: basic ${basic}`;
}

export function buildCloneUrl(owner: string, repo: string): string {
  return `https://github.com/${owner}/${repo}.git`;
}

export function splitOwnerRepo(targetRepo: string): { owner: string; repo: string } {
  const [owner, repo] = targetRepo.split("/");
  if (!owner || !repo) {
    throw new Error(`Invalid targetRepo "${targetRepo}", expected "owner/repo"`);
  }
  return { owner, repo };
}
