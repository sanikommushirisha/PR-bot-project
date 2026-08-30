import type { Octokit } from "@octokit/rest";
import type { PullRequestResult } from "../types/index.js";

export interface CreateDraftPrParams {
  octokit: Octokit;
  owner: string;
  repo: string;
  base: string;
  head: string;
  title: string;
  /** Original Telegram request text + message link, embedded verbatim in the PR body. */
  telegramRequestText: string;
  telegramMessageLink: string;
}

export async function createDraftPullRequest(params: CreateDraftPrParams): Promise<PullRequestResult> {
  const body = [
    "This PR was opened automatically by telegram-agent-bridge from a Telegram request.",
    "It has **not** been merged or approved -- review it like any other PR.",
    "",
    "### Original request",
    "> " + params.telegramRequestText.split("\n").join("\n> "),
    "",
    `[View the Telegram message](${params.telegramMessageLink})`,
  ].join("\n");

  const { data } = await params.octokit.rest.pulls.create({
    owner: params.owner,
    repo: params.repo,
    base: params.base,
    head: params.head,
    title: params.title,
    body,
    draft: true,
  });

  return { url: data.html_url, number: data.number, branch: params.head };
}
