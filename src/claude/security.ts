import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";

interface BashRule {
  pattern: RegExp;
  reason: string;
}

/**
 * Denylist of shell patterns that have no legitimate place in a "make a code
 * change and run tests/linters" task. Not a sandbox — a determined agent
 * could still phrase around it — but it's a real check where today there is
 * none at all, since Bash is otherwise unconditionally auto-approved.
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
  { pattern: /\.aws\/credentials/i, reason: "reading AWS credentials" },
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
];

function findMatch(command: string): BashRule | null {
  for (const rule of BASH_RULES) {
    if (rule.pattern.test(command)) return rule;
  }
  return null;
}

/**
 * `canUseTool` gate for the agent session: Bash commands are checked against
 * a denylist before running; every other tool is passed through unchanged.
 */
export const guardBashTool: CanUseTool = async (toolName, input) => {
  if (toolName !== "Bash") {
    return { behavior: "allow", updatedInput: input };
  }

  const command = typeof input.command === "string" ? input.command : "";
  const matched = findMatch(command);

  if (matched) {
    return {
      behavior: "deny",
      message:
        `Blocked for safety: ${matched.reason}. This automated Slack-to-PR pipeline never allows this — ` +
        "it must not touch the real database, migrations, or credentials, and must never push/configure git itself. " +
        "If the task genuinely requires this, stop and explain why in your final summary instead of retrying.",
    };
  }

  return { behavior: "allow", updatedInput: input };
};
