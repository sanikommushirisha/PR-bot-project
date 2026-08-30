import type { Octokit } from "@octokit/rest";

export interface CreateDraftPrParams {
  octokit: Octokit;
  owner: string;
  repo: string;
  base: string;
  head: string;
  title: string;
  body: string;
}

export async function createDraftPullRequest(params: CreateDraftPrParams): Promise<string> {
  const { octokit, owner, repo, base, head, title, body } = params;
  const { data } = await octokit.pulls.create({
    owner,
    repo,
    base,
    head,
    title,
    body,
    draft: true,
  });
  return data.html_url;
}
