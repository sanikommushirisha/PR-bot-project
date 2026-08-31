export interface TaskRepoTarget {
  /** The slash command that routes to this repo, e.g. "/task-lesser". */
  command: string;
  /** "owner/repo" */
  slug: string;
  baseBranch: string;
}

/**
 * One entry per `/task-*` command. Adding a repo means: register the new
 * slash command in the Slack app config, then add one entry here.
 */
export const TASK_REPO_TARGETS: TaskRepoTarget[] = [
  { command: "/task-lesser", slug: "sanikommushirisha/lesser", baseBranch: "develop" },
  // lesser-blog has both `develop` and `main` (currently identical) — using
  // `develop` to match lesser's convention. Confirm this is actually right.
  { command: "/task-blog", slug: "sanikommushirisha/lesser-blog", baseBranch: "develop" },
];
