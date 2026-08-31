# slack-agent-bridge

Slack message → job → Claude agent session → draft PR. No auto-merge, ever.

A user sends `/task <description>` in a configured Slack channel. That creates a
job row in SQLite. A separate worker process picks it up, clones the target
repo, runs a Claude Agent SDK session on a fresh branch, then deterministically
commits, pushes, and opens a **draft** pull request via the GitHub API. The
worker replies in the originating Slack thread with the PR link (or a
failure message — nothing fails silently).

## Architecture

```
src/
  slack/      Bolt app (Socket Mode): /task /status /cancel /help commands, permalink helper
  github/     Octokit client, clone/branch/commit/push, draft PR creation
  claude/     Claude Agent SDK session + prompt construction
  db/         SQLite schema, migration-on-startup, typed job helpers
  worker/     polling loop + per-job pipeline (clone -> agent -> commit -> PR)
  config/     env var loading/validation (zod)
  types/      shared TypeScript types
  index.ts    entrypoint: bot + Fastify API (Slack Socket Mode, no public HTTPS needed)
  worker.ts   entrypoint: worker (separate PM2 process)
```

Two long-running processes, managed by PM2:
- **bot+API** (`src/index.ts`) — Slack app (Socket Mode) + a tiny Fastify API (`/health`, `/jobs/:id`).
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
- A Slack app with Socket Mode enabled (see below)

## Setting up the Slack app

1. Create an app at [api.slack.com/apps](https://api.slack.com/apps) ("From scratch" is fine).
2. Under **Socket Mode**, enable it and generate an app-level token with the
   `connections:write` scope — this is `SLACK_APP_TOKEN` (starts with `xapp-`).
3. Under **OAuth & Permissions**, add these Bot Token Scopes:
   - `chat:write` — post job updates
   - `channels:read` (or `groups:read` for a private channel) — resolve permalinks for the PR body
   - `channels:history` (or `groups:history` for a private channel) — read a thread's parent message when `/task` is run inside a thread, for context
4. Install the app to your workspace. Copy the **Bot User OAuth Token** — this
   is `SLACK_BOT_TOKEN` (starts with `xoxb-`).
5. Under **Slash Commands**, create four commands: `/task`, `/status`,
   `/cancel`, `/help`. Socket Mode delivers them over the websocket connection,
   so the Request URL field can be left as a placeholder.
6. Invite the bot to the channel you want it to operate in (`/invite @your-bot`),
   then right-click the channel name → **View channel details** to find its
   channel ID (or check the end of the channel's URL) — that's
   `SLACK_ALLOWED_CHANNEL_ID`.

## Environment variables

See `.env.example`. Copy it to `.env` and fill in:

| Variable | Required | Description |
|---|---|---|
| `SLACK_BOT_TOKEN` | yes | Bot User OAuth Token (`xoxb-...`) |
| `SLACK_APP_TOKEN` | yes | App-level token for Socket Mode (`xapp-...`) |
| `SLACK_ALLOWED_CHANNEL_ID` | yes | Only this channel's `/task` commands are accepted |
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
pnpm dev:bot      # Slack app (Socket Mode) + Fastify API
pnpm dev:worker   # job worker
```

Then, in the configured Slack channel, send:

```
/task add a health check endpoint to the API
```

You should get an immediate "queued" message with a job id, and — once the
worker picks it up — a follow-up reply in the same thread with the draft PR
link (or a failure reason).

Running `/task` from inside an existing thread carries that thread's parent
message along as extra context for the agent, the same way replying to a
message did before.

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
cd slack-agent-bridge
pnpm install
cp .env.example .env   # fill in real values
pnpm build             # compiles src/ -> dist/

npm install -g pm2
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup            # follow the printed command to enable boot-time restart
```

`ecosystem.config.cjs` defines two apps, matching the two processes:
`slack-agent-bridge-bot` (`dist/index.js`) and
`slack-agent-bridge-worker` (`dist/worker.js`). Useful commands:

```bash
pm2 status
pm2 logs slack-agent-bridge-worker
pm2 restart slack-agent-bridge-bot
```

The bot uses Slack Socket Mode, so no public HTTPS endpoint or inbound
security-group rule is required.

## Safety notes

- The agent is instructed not to commit, push, or open a PR itself — the
  worker does all git/GitHub actions deterministically after the agent
  session finishes.
- Every opened PR is a **draft**. Nothing in this codebase auto-merges.
- Only the configured `SLACK_ALLOWED_CHANNEL_ID` can create jobs, and only via
  the explicit `/task` command — no message is ever treated as a task
  implicitly.
