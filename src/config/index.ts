import { config as loadDotenv } from "dotenv";
import { z } from "zod";

loadDotenv();

const envSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1, "TELEGRAM_BOT_TOKEN is required"),
  TELEGRAM_ALLOWED_CHAT_ID: z.coerce.number({
    invalid_type_error: "TELEGRAM_ALLOWED_CHAT_ID must be a number",
  }),

  GITHUB_TOKEN: z.string().min(1, "GITHUB_TOKEN is required"),
  GITHUB_REPO: z
    .string()
    .regex(/^[^/\s]+\/[^/\s]+$/, "GITHUB_REPO must be in 'owner/repo' format"),
  GITHUB_BASE_BRANCH: z.string().min(1).default("main"),

  ANTHROPIC_API_KEY: z.string().min(1, "ANTHROPIC_API_KEY is required"),

  SCRATCH_DIR: z.string().min(1).default("./scratch"),
  DB_PATH: z.string().min(1).default("./data/jobs.sqlite"),
  JOB_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(7000),
  STUCK_JOB_TIMEOUT_MS: z.coerce.number().int().positive().default(1_800_000),

  PORT: z.coerce.number().int().positive().default(3000),
});

function loadEnv() {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error("Invalid environment configuration:");
    for (const issue of parsed.error.issues) {
      console.error(`  - ${issue.path.join(".")}: ${issue.message}`);
    }
    process.exit(1);
  }
  return parsed.data;
}

const env = loadEnv();
const [githubOwner, githubRepoName] = env.GITHUB_REPO.split("/");

/**
 * `github.auth` is a discriminated union so swapping PAT auth for
 * `@octokit/auth-app` later only means changing this shape + the factory
 * in src/github/client.ts, not any calling code.
 */
export const config = {
  telegram: {
    botToken: env.TELEGRAM_BOT_TOKEN,
    allowedChatId: env.TELEGRAM_ALLOWED_CHAT_ID,
  },
  github: {
    auth: { type: "pat" as const, token: env.GITHUB_TOKEN },
    owner: githubOwner,
    repo: githubRepoName,
    slug: env.GITHUB_REPO,
    baseBranch: env.GITHUB_BASE_BRANCH,
  },
  anthropic: {
    apiKey: env.ANTHROPIC_API_KEY,
  },
  worker: {
    scratchDir: env.SCRATCH_DIR,
    dbPath: env.DB_PATH,
    pollIntervalMs: env.JOB_POLL_INTERVAL_MS,
    stuckJobTimeoutMs: env.STUCK_JOB_TIMEOUT_MS,
  },
  server: {
    port: env.PORT,
  },
} as const;

export type AppConfig = typeof config;
export type GithubAuthConfig = AppConfig["github"]["auth"];
