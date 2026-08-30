/** "Fix the login bug!!" -> "fix-the-login-bug" (truncated, git-ref-safe). */
export function slugify(text: string, maxLength = 40): string {
  const slug = text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.slice(0, maxLength).replace(/-+$/, "") || "task";
}

export function buildBranchName(taskDescription: string, jobId: string): string {
  return `agent/${slugify(taskDescription)}-${jobId}`;
}
