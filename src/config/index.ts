import "dotenv/config";
import { z } from "zod";

/**
 * All required env vars in one schema so a missing/malformed value fails at
 * process startup with one clear error, instead of surfacing halfway through
 * a job (e.g. a job pulling a PAT that turns out to be unset only when it
 * tries to push).
 */
const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

    // --- Fastify server ---
    PORT: z.coerce.number().int().positive().default(3000),
    HOST: z.string().default("0.0.0.0"),

    // --- Redis / BullMQ ---
    REDIS_URL: z.string().url(),

    // --- Telegram (bot API, long polling) ---
    /** Token from @BotFather, e.g. "123456789:AAE...". */
    TELEGRAM_BOT_TOKEN: z.string().regex(/^\d+:[\w-]+$/, "expected a BotFather token, e.g. \"123456789:AAE...\""),
    /** Chat (group/supergroup/channel) ID where the trigger (command / reaction) is honored. */
    TELEGRAM_TRIGGER_CHAT_ID: z.string().min(1),
    /** Emoji (the literal character, not a name) that triggers a task when reacted onto a message. */
    TELEGRAM_TRIGGER_EMOJI: z.string().min(1).default("🚀"),

    // --- GitHub ---
    // Either a PAT, or a GitHub App (all three App vars together). Cross-field
    // check below enforces that one full auth method is actually present.
    GITHUB_TOKEN: z.string().optional(),
    GITHUB_APP_ID: z.string().optional(),
    GITHUB_APP_PRIVATE_KEY: z.string().optional(),
    GITHUB_APP_INSTALLATION_ID: z.string().optional(),
    GITHUB_DEFAULT_REPO: z.string().regex(/^[^/\s]+\/[^/\s]+$/, "expected \"owner/repo\""),
    GITHUB_DEFAULT_BASE_BRANCH: z.string().default("main"),

    // --- Claude ---
    ANTHROPIC_API_KEY: z.string().min(1),

    // --- Worker ---
    /** Where scratch clones for in-flight jobs live. */
    WORKER_SCRATCH_DIR: z.string().default("./scratch"),
  })
  .superRefine((env, ctx) => {
    const hasPat = !!env.GITHUB_TOKEN;
    const hasApp = !!(env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY && env.GITHUB_APP_INSTALLATION_ID);

    if (!hasPat && !hasApp) {
      ctx.addIssue({
        code: "custom",
        message:
          "Set either GITHUB_TOKEN (PAT) or all of GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY + GITHUB_APP_INSTALLATION_ID (GitHub App).",
        path: ["GITHUB_TOKEN"],
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    // eslint-disable-next-line no-console
    console.error(`Invalid environment configuration:\n${issues}`);
    process.exit(1);
  }
  return parsed.data;
}

export const env = loadEnv();

/** Narrowed GitHub auth config, resolved once so callers don't re-derive the PAT/App branch. */
export type GithubAuthConfig =
  | { kind: "pat"; token: string }
  | { kind: "app"; appId: string; privateKey: string; installationId: string };

export function resolveGithubAuth(e: Env = env): GithubAuthConfig {
  if (e.GITHUB_APP_ID && e.GITHUB_APP_PRIVATE_KEY && e.GITHUB_APP_INSTALLATION_ID) {
    return {
      kind: "app",
      appId: e.GITHUB_APP_ID,
      privateKey: e.GITHUB_APP_PRIVATE_KEY,
      installationId: e.GITHUB_APP_INSTALLATION_ID,
    };
  }
  if (e.GITHUB_TOKEN) {
    return { kind: "pat", token: e.GITHUB_TOKEN };
  }
  // Unreachable: envSchema.superRefine already guarantees one of these is set.
  throw new Error("No GitHub auth configured");
}
