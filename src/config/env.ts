import { config as loadDotenv } from "dotenv";
import { z } from "zod";

loadDotenv();

const envSchema = z.object({
  SLACK_BOT_TOKEN: z.string().min(1, "SLACK_BOT_TOKEN is required"),
  SLACK_SIGNING_SECRET: z.string().min(1, "SLACK_SIGNING_SECRET is required"),
  SLACK_ALLOWED_CHANNEL_ID: z.string().min(1, "SLACK_ALLOWED_CHANNEL_ID is required"),

  LINEAR_API_KEY: z.string().min(1, "LINEAR_API_KEY is required"),
  LINEAR_TEAM_KEY: z.string().min(1, "LINEAR_TEAM_KEY is required (e.g. 'LES')"),
  LINEAR_WEBHOOK_SECRET: z.string().min(1, "LINEAR_WEBHOOK_SECRET is required"),
  LINEAR_TRIGGER_STATE_NAME: z.string().min(1).default("In Progress"),

  GITHUB_TOKEN: z.string().min(1, "GITHUB_TOKEN is required"),
  GITHUB_REPO: z
    .string()
    .regex(/^[^/\s]+\/[^/\s]+$/, "GITHUB_REPO must be in 'owner/repo' format"),
  GITHUB_BASE_BRANCH: z.string().min(1).default("develop"),

  ANTHROPIC_API_KEY: z.string().min(1, "ANTHROPIC_API_KEY is required"),

  SCRATCH_DIR: z.string().min(1).default("./scratch"),
  DB_PATH: z.string().min(1).default("./data/jobs.sqlite"),
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

export const config = {
  slack: {
    botToken: env.SLACK_BOT_TOKEN,
    signingSecret: env.SLACK_SIGNING_SECRET,
    allowedChannelId: env.SLACK_ALLOWED_CHANNEL_ID,
  },
  linear: {
    apiKey: env.LINEAR_API_KEY,
    teamKey: env.LINEAR_TEAM_KEY,
    webhookSecret: env.LINEAR_WEBHOOK_SECRET,
    triggerStateName: env.LINEAR_TRIGGER_STATE_NAME,
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
  },
  server: {
    port: env.PORT,
  },
} as const;

export type AppConfig = typeof config;
export type GithubAuthConfig = AppConfig["github"]["auth"];
