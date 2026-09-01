# slack-linear-claude-agent

Slack `/task` → Linear issue → (you move it to "In Progress") → Claude agent
session → draft PR into `develop`. No auto-merge, ever. Fully event-driven,
no database — Linear itself is the state store.

## Flow

1. `/task <description>` in the configured Slack channel creates a Linear
   issue (title = task, body = requester + description), with the Slack
   channel id and thread ts embedded invisibly in the issue description so
   the flow can find its way back to the right thread later without a DB.
2. Nothing happens automatically after that — **you** move the issue to
   the trigger state (`In Progress` by default) in Linear when you're ready
   for the agent to actually work on it.
3. Linear's webhook fires. The server clones the target repo from `develop`,
   runs a Claude Agent SDK session with the issue's title/description/comments
   as context, then deterministically commits, pushes, and opens a **draft**
   PR back into `develop`.
4. The issue moves to `In Review` (success) or `Canceled` (failure), and a
   message posts back into the original Slack thread either way.

## Architecture

```
src/
  config/       env validation (zod) + SDK client factories (Slack, Linear, GitHub)
  middlewares/  raw-body capture + Slack/Linear HMAC signature verification
  webhooks/     Express controllers: POST /webhooks/slack/commands, POST /webhooks/linear
  services/     slackService, linearService, githubService, claudeService (+ Bash guardrails)
  types/        Slack slash-command payload, Linear webhook payload
  index.ts      Express app entrypoint
```

One process, one port. No queue, no polling loop, no SQLite — every
transition is driven by an inbound webhook, and Linear's own issue
description is the only place any cross-request state lives.

## Prerequisites

- Node.js 20+ and pnpm
- A GitHub personal access token with `repo` scope on the target repo
- An Anthropic API key
- A Slack app (Events/webhook mode, **not** Socket Mode — this needs a real
  public HTTPS URL) with a slash command configured
- A Linear API key, a team, and (once this server has a public URL) a
  webhook pointed at it

## A public HTTPS URL is required

Unlike a Socket-Mode Slack bot, both Slack's slash command delivery and
Linear's webhooks call **into** this server — `localhost` won't work for
either. For local development, expose your local port with a tunnel:

```bash
ngrok http 3000
# or: cloudflared tunnel --url http://localhost:3000
```

Use the `https://...ngrok-free.app` (or equivalent) URL as the Request URL
when configuring both Slack and Linear below. For production, this means an
EC2 deployment for this specific flow **does** need a domain + TLS in front
of it (unlike the Socket-Mode version this project used before) — a
reverse proxy (nginx/Caddy) with a Let's Encrypt cert pointed at port 3000
is the standard shape.

## Setting up Slack

1. Create an app at [api.slack.com/apps](https://api.slack.com/apps).
2. **Basic Information → App Credentials** — copy the **Signing Secret**,
   this is `SLACK_SIGNING_SECRET`.
3. **OAuth & Permissions → Bot Token Scopes** — add `chat:write`. Install the
   app and copy the **Bot User OAuth Token** (`xoxb-...`) — this is
   `SLACK_BOT_TOKEN`. If you add scopes after already installing, reinstall
   and copy the newly issued token.
4. **Slash Commands → Create New Command**:
   - Command: `/task`
   - Request URL: `https://<your-public-url>/webhooks/slack/commands`
5. Invite the bot to your channel (`/invite @your-bot`), then find the
   channel id (channel details, or the end of its URL) — that's
   `SLACK_ALLOWED_CHANNEL_ID`.

## Setting up Linear

1. **Settings → Security & access → Personal API keys** — create one, this
   is `LINEAR_API_KEY`.
2. Find your team's key (the prefix on its issue ids, e.g. `LES` for
   `LES-123`) — this is `LINEAR_TEAM_KEY`.
3. **Settings → API → Webhooks → New webhook**:
   - URL: `https://<your-public-url>/webhooks/linear`
   - Enable the **Issues** event type
   - Create it, then copy the **signing secret** it shows you once — this
     is `LINEAR_WEBHOOK_SECRET`
4. `LINEAR_TRIGGER_STATE_NAME` (default `"In Progress"`) must exactly match
   a real workflow state name in your team.

## Environment variables

See `.env.example`.

| Variable | Required | Description |
|---|---|---|
| `LINEAR_API_KEY` | yes | Personal API key |
| `LINEAR_TEAM_KEY` | yes | Team key, e.g. `LES` |
| `LINEAR_TRIGGER_STATE_NAME` | no (default `In Progress`) | Moving an issue to this state starts the agent |
| `LINEAR_WEBHOOK_SECRET` | yes | Signing secret from the webhook you create above |
| `SLACK_BOT_TOKEN` | yes | Bot User OAuth Token (`xoxb-...`) |
| `SLACK_ALLOWED_CHANNEL_ID` | yes | Only this channel's `/task` is accepted |
| `SLACK_SIGNING_SECRET` | yes | From Basic Information → App Credentials |
| `GITHUB_TOKEN` | yes | PAT with `repo` scope |
| `GITHUB_REPO` | yes | Target repo, `owner/repo` |
| `GITHUB_BASE_BRANCH` | no (default `develop`) | Base branch cloned from and PR'd into |
| `ANTHROPIC_API_KEY` | yes | Used by the Claude Agent SDK |
| `SCRATCH_DIR` | no (default `./scratch`) | Where the repo gets cloned per run |
| `PORT` | no (default `3000`) | Express server port |

## Running locally

```bash
pnpm install
cp .env.example .env   # fill in the values above

pnpm dev
```

In another terminal, start a tunnel and point Slack's slash command + the
Linear webhook at the tunnel URL (see above), then in Slack:

```
/task add a health check endpoint to the API
```

Check the confirmation message for the Linear issue link, then in Linear
drag/move that issue to **In Progress**. Watch the server logs — it should
clone, run the agent, and post a draft PR link back into the Slack thread
within a few minutes.

## Safety notes

- The agent is instructed not to commit, push, or open a PR itself — this
  server does all git/GitHub actions deterministically after the agent
  session finishes.
- The agent's Bash tool calls are checked against a denylist
  (`src/services/claudeSecurity.ts`) blocking destructive filesystem
  operations, privilege escalation, remote-script execution, credential
  access, and database/migration commands — not a sandbox, but a real check.
- Every opened PR is a **draft**. Nothing here auto-merges.
- Both webhook endpoints verify their sender's HMAC signature
  (`src/middlewares/`) before doing anything — an unsigned or forged
  request is rejected with 401.
- Re-triggering the same issue (moving it back to the trigger state) is
  safe — each run gets a uniquely timestamped branch name, so it can't
  collide with a branch already pushed by a previous run.
