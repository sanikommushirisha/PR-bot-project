# telegram-agent-bridge

Telegram message → job → Claude agent session → draft PR. No auto-merge, ever.

A user sends `/task <description>` in a configured Telegram chat. That creates a
job row in SQLite. A separate worker process picks it up, clones the target
repo, runs a Claude Agent SDK session on a fresh branch, then deterministically
commits, pushes, and opens a **draft** pull request via the GitHub API. The
worker replies in the originating Telegram thread with the PR link (or a
failure message — nothing fails silently).

## Architecture

```
src/
  telegram/   Telegraf bot: /task command -> job creation, message-link helper
  github/     Octokit client, clone/branch/commit/push, draft PR creation
  claude/     Claude Agent SDK session + prompt construction
  db/         SQLite schema, migration-on-startup, typed job helpers
  worker/     polling loop + per-job pipeline (clone -> agent -> commit -> PR)
  config/     env var loading/validation (zod)
  types/      shared TypeScript types
  index.ts    entrypoint: bot + Fastify API (long-polling Telegram, no public HTTPS needed)
  worker.ts   entrypoint: worker (separate PM2 process)
```

Two long-running processes, managed by PM2:
- **bot+API** (`src/index.ts`) — Telegram bot (long polling) + a tiny Fastify API (`/health`, `/jobs/:id`).
- **worker** (`src/worker.ts`) — polls SQLite for `pending` jobs and runs the whole pipeline.

Jobs live in a `jobs` table in SQLite (`better-sqlite3`), with `status`
`pending → running → completed | failed`. There is no separate queue system —
the worker claims the oldest pending job with a single atomic
`UPDATE ... WHERE status = 'pending'`, so it's safe even if you ever run more
than one worker process.

## Prerequisites

- Node.js 20+ and pnpm
- A GitHub personal access token with `repo` scope on the target repo
- An Anthropic API key
- A Telegram bot token (see below)

## Getting a Telegram bot token and chat id

1. Open a chat with **@BotFather** on Telegram, send `/newbot`, and follow the
   prompts. BotFather gives you a token — this is `TELEGRAM_BOT_TOKEN`.
2. Add the bot to the group chat you want it to operate in.
3. Send any message in that group, then call:
   ```
   https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/getUpdates
   ```
   in a browser or via `curl`. Look for `"chat":{"id": ...}` in the response —
   that's `TELEGRAM_ALLOWED_CHAT_ID`. For a supergroup it will be a large
   negative number (e.g. `-1001234567890`).
4. If the bot is in privacy mode (default for group bots), it may only
   receive messages that start with `/`. That's fine — the whole workflow is
   built around the explicit `/task` command, so normal chat never triggers it.

## Environment variables

See `.env.example`. Copy it to `.env` and fill in:

| Variable | Required | Description |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | yes | Token from BotFather |
| `TELEGRAM_ALLOWED_CHAT_ID` | yes | Only this chat's `/task` commands are accepted |
| `GITHUB_TOKEN` | yes | PAT with `repo` scope (auth is structured so swapping to a GitHub App later is a config change — see `src/github/client.ts`) |
| `GITHUB_REPO` | yes | Target repo, `owner/repo` |
| `GITHUB_BASE_BRANCH` | no (default `main`) | Base branch for draft PRs |
| `ANTHROPIC_API_KEY` | yes | Used by the Claude Agent SDK |
| `SCRATCH_DIR` | no (default `./scratch`) | Where repos get cloned per-job |
| `DB_PATH` | no (default `./data/jobs.sqlite`) | SQLite file path |
| `JOB_POLL_INTERVAL_MS` | no (default `7000`) | Worker poll interval |
| `STUCK_JOB_TIMEOUT_MS` | no (default `1800000`, 30 min) | How long a job can sit `running` before the worker assumes a crash and requeues it |
| `PORT` | no (default `3000`) | Fastify API port |

Config is validated with zod at startup in both processes — invalid or
missing vars print a clear error and exit immediately rather than failing
partway through a job.

## Running locally

```bash
pnpm install
cp .env.example .env   # then fill in the values above

# Two separate processes, each in its own terminal:
pnpm dev:bot      # Telegram bot + Fastify API (long polling)
pnpm dev:worker   # job worker
```

Then, in the configured Telegram chat, send:

```
/task add a health check endpoint to the API
```

You should get an immediate "queued" reply with a job id, and — once the
worker picks it up — a follow-up message with the draft PR link (or a
failure reason).

### Standalone module tests

Before wiring everything together, each integration module can be exercised
on its own:

```bash
# Clones GITHUB_REPO, makes a trivial commit, pushes, opens a draft PR
pnpm test:github

# Runs a Claude Agent SDK task against a local repo checkout you point it at
pnpm test:claude -- /path/to/local/repo "add a CONTRIBUTING.md file"
```

## Deploying on a single EC2 instance with PM2

```bash
# On the instance:
git clone <this repo>
cd telegram-agent-bridge
pnpm install
cp .env.example .env   # fill in real values
pnpm build             # compiles src/ -> dist/

npm install -g pm2
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup            # follow the printed command to enable boot-time restart
```

`ecosystem.config.cjs` defines two apps, matching the two processes:
`telegram-agent-bridge-bot` (`dist/index.js`) and
`telegram-agent-bridge-worker` (`dist/worker.js`). Useful commands:

```bash
pm2 status
pm2 logs telegram-agent-bridge-worker
pm2 restart telegram-agent-bridge-bot
```

The bot uses Telegram long polling, so no public HTTPS endpoint or inbound
security-group rule is required. To switch to webhook mode later, replace
`bot.launch()` in `src/index.ts` with `bot.createWebhook(...)` mounted onto
the Fastify app — the rest of the pipeline is unaffected.

## Safety notes

- The agent is instructed not to commit, push, or open a PR itself — the
  worker does all git/GitHub actions deterministically after the agent
  session finishes.
- Every opened PR is a **draft**. Nothing in this codebase auto-merges.
- Only the configured `TELEGRAM_ALLOWED_CHAT_ID` can create jobs, and only via
  the explicit `/task` command — no message is ever treated as a task
  implicitly.
