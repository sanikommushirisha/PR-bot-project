import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";

interface BashRule {
  pattern: RegExp;
  reason: string;
}

/**
 * Denylist of shell patterns that have no legitimate place in a "make a code
 * change and run tests/linters" task. Not a sandbox — a determined agent
 * could still phrase around it — but it's a real check where otherwise Bash
 * would be unconditionally auto-approved.
 */
const BASH_RULES: BashRule[] = [
  // --- generic destructive / privilege / exfiltration patterns ---
  {
    pattern: /\brm\s+(-\w*r\w*f\w*|-\w*f\w*r\w*)\s+(\/|~|\$HOME|\.\.)(\s|$)/i,
    reason: "destructive filesystem operation (rm -rf on /, ~, $HOME, or a parent directory)",
  },
  { pattern: /\bsudo\b/i, reason: "privilege escalation" },
  { pattern: /\bcurl\b[^|]*\|\s*(sudo\s+)?(sh|bash|zsh)\b/i, reason: "piping a remote script into a shell" },
  { pattern: /\bwget\b[^|]*\|\s*(sudo\s+)?(sh|bash|zsh)\b/i, reason: "piping a remote script into a shell" },
  { pattern: /\bchmod\s+(-R\s+)?777\b/i, reason: "overly permissive chmod" },
  { pattern: /\bmkfs(\.\w+)?\b/i, reason: "filesystem formatting" },
  { pattern: /\bdd\s+if=/i, reason: "raw disk write" },
  { pattern: /\b(shutdown|reboot|poweroff|halt)\b/i, reason: "host shutdown/reboot" },
  {
    pattern: /\bgit\s+push\b/i,
    reason: "git push (the worker process pushes deterministically after you finish; you never should)",
  },
  { pattern: /\bgit\s+(config|remote)\b/i, reason: "modifying git config or remotes" },
  { pattern: /\.ssh\/(id_|authorized_keys|known_hosts)/i, reason: "reading SSH credentials" },
  { pattern: /\.aws\/(credentials|config)\b/i, reason: "reading AWS credentials/config" },
  { pattern: /\.config\/gcloud\b/i, reason: "reading gcloud credentials/config" },
  { pattern: /\.azure\b/i, reason: "reading Azure CLI credentials/config" },
  { pattern: /\.kube\/config\b/i, reason: "reading a Kubernetes kubeconfig (cluster credentials)" },
  { pattern: /\.docker\/config\.json\b/i, reason: "reading Docker registry credentials" },
  { pattern: /\.npmrc\b/i, reason: "reading npm registry credentials" },
  { pattern: /\.netrc\b/i, reason: "reading .netrc credentials" },
  { pattern: /\.pypirc\b/i, reason: "reading PyPI credentials" },
  { pattern: /\b(cat|less|head|tail|more)\s+\S*\.env(\.\w+)?\b/i, reason: "reading a .env file" },
  { pattern: /:\(\)\s*\{\s*:\|:&\s*\}\s*;\s*:/, reason: "fork bomb" },

  // --- database / migration: this pipeline must never touch real data ---
  { pattern: /\bsupabase\s+\S+/i, reason: "Supabase CLI invocation (this pipeline must never touch the real database)" },
  { pattern: /\bprisma\s+migrate\b/i, reason: "Prisma migration" },
  { pattern: /\bdrizzle-kit\s+(push|migrate)\b/i, reason: "Drizzle migration" },
  { pattern: /\bknex\s+migrate\b/i, reason: "Knex migration" },
  { pattern: /\b(rails|rake)\s+db:migrate\b/i, reason: "Rails/Rake migration" },
  { pattern: /\b(manage\.py|django-admin)\s+migrate\b/i, reason: "Django migration" },
  { pattern: /\balembic\s+(upgrade|downgrade)\b/i, reason: "Alembic migration" },
  { pattern: /\btypeorm\s+migration:(run|revert)\b/i, reason: "TypeORM migration" },
  { pattern: /\bsequelize(-cli)?\s+db:migrate\b/i, reason: "Sequelize migration" },
  { pattern: /\bflyway\s+migrate\b/i, reason: "Flyway migration" },
  { pattern: /\bliquibase\s+update\b/i, reason: "Liquibase migration" },
  { pattern: /\bpsql\b/i, reason: "direct Postgres client" },
  { pattern: /\bpg_(dump|restore)\b/i, reason: "Postgres dump/restore" },
  { pattern: /\bmysql\b/i, reason: "direct MySQL client" },
  { pattern: /(^|[;&|]\s*)(mongosh|mongo)\b/i, reason: "direct MongoDB client" },
  { pattern: /\bredis-cli\b/i, reason: "direct Redis client" },
  {
    pattern: /\b(echo|printenv)\b[^\n]*\b(DATABASE_URL|SUPABASE_\w*KEY|SUPABASE_\w*URL|POSTGRES_\w+|DB_PASSWORD|DB_URL)\b/i,
    reason: "reading a database credential env var",
  },
  {
    pattern: /\benv\b\s*\|\s*grep\s+.*(SUPABASE|DATABASE_URL|POSTGRES|DB_PASSWORD|SECRET|_KEY)/i,
    reason: "grepping the environment for database/secret vars",
  },
  { pattern: /\b(curl|wget)\b[^\n]*service_role/i, reason: "authenticated Supabase admin API call" },

  // --- deployments / infra / CI-CD: this pipeline only ever produces a draft PR ---
  { pattern: /\bvercel\s+\S+/i, reason: "Vercel CLI (deployment platform)" },
  { pattern: /\bnetlify\s+\S+/i, reason: "Netlify CLI (deployment platform)" },
  { pattern: /\bfirebase\s+(deploy|functions:deploy|hosting:)/i, reason: "Firebase deploy" },
  { pattern: /\bheroku\s+\S+/i, reason: "Heroku CLI (deployment platform)" },
  { pattern: /\brailway\s+(up|deploy)\b/i, reason: "Railway deploy" },
  { pattern: /\bflyctl?\s+deploy\b/i, reason: "Fly.io deploy" },
  { pattern: /\baws\s+\S+/i, reason: "AWS CLI (real cloud infrastructure)" },
  { pattern: /\bgcloud\s+\S+/i, reason: "gcloud CLI (real cloud infrastructure)" },
  { pattern: /\baz\s+\S+/i, reason: "Azure CLI (real cloud infrastructure)" },
  { pattern: /\bkubectl\s+\S+/i, reason: "kubectl (real cluster access)" },
  { pattern: /\bhelm\s+(install|upgrade|uninstall|delete)\b/i, reason: "Helm release management" },
  { pattern: /\bterraform\s+(apply|destroy|import)\b/i, reason: "Terraform apply/destroy (real infrastructure changes)" },
  { pattern: /\b(sam|cdk)\s+deploy\b/i, reason: "AWS SAM/CDK deploy" },
  { pattern: /\bserverless\s+deploy\b/i, reason: "Serverless Framework deploy" },
  { pattern: /\beb\s+deploy\b/i, reason: "Elastic Beanstalk deploy" },
  { pattern: /\bansible-playbook\b/i, reason: "Ansible playbook (infrastructure automation)" },
  { pattern: /\bdocker\s+(push|login)\b/i, reason: "Docker registry push/login" },
];

function findMatch(command: string): BashRule | null {
  for (const rule of BASH_RULES) {
    if (rule.pattern.test(command)) return rule;
  }
  return null;
}

const PROTECTED_FILE_PATTERNS: RegExp[] = [
  /\.github\/workflows\//i,
  /\.gitlab-ci\.ya?ml$/i,
  /^Jenkinsfile$/i,
  /\.circleci\//i,
  /azure-pipelines\.ya?ml$/i,
  /\.buildkite\//i,
];

function isProtectedFilePath(filePath: string): boolean {
  return PROTECTED_FILE_PATTERNS.some((pattern) => pattern.test(filePath));
}

/**
 * `canUseTool` gate for the agent session:
 * - Bash commands are checked against the denylist above.
 * - Write/Edit calls targeting a CI pipeline definition are blocked outright
 *   — a denylist can't catch "wrote a workflow file that runs on the next
 *   push", since that's a file-content risk, not a command-text one.
 * Everything else is passed through unchanged.
 */
export const guardAgentTool: CanUseTool = async (toolName, input) => {
  if (toolName === "Bash") {
    const command = typeof input.command === "string" ? input.command : "";
    const matched = findMatch(command);
    if (matched) {
      return {
        behavior: "deny",
        message:
          `Blocked for safety: ${matched.reason}. This automated pipeline never allows this — ` +
          "it must not touch real databases, credentials, or live infrastructure/deployments, and must never push/configure git itself. " +
          "If the task genuinely requires this, stop and explain why in your final summary instead of retrying.",
      };
    }
    return { behavior: "allow", updatedInput: input };
  }

  if (toolName === "Write" || toolName === "Edit") {
    const filePath = typeof input.file_path === "string" ? input.file_path : "";
    if (filePath && isProtectedFilePath(filePath)) {
      return {
        behavior: "deny",
        message:
          "Blocked for safety: this pipeline never allows creating or editing CI pipeline definitions " +
          "(e.g. GitHub Actions workflows) — a change here could run on the next push without human review. " +
          "If the task genuinely requires this, stop and explain why in your final summary instead of retrying.",
      };
    }
  }

  return { behavior: "allow", updatedInput: input };
};
