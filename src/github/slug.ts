export interface RepoSlug {
  owner: string;
  repo: string;
}

export function parseRepoSlug(slug: string): RepoSlug {
  const [owner, repo] = slug.split("/");
  if (!owner || !repo) {
    throw new Error(`Invalid repo slug "${slug}", expected "owner/repo"`);
  }
  return { owner, repo };
}

export function slugifyTask(description: string, maxLength = 40): string {
  const slug = description
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength)
    .replace(/-+$/g, "");
  return slug || "task";
}

export function buildBranchName(taskDescription: string, jobId: number): string {
  return `agent/${slugifyTask(taskDescription)}-${jobId}`;
}
