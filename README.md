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
5. If someone posts an image (pasted or attached) as a reply in that same
   Slack thread, it's uploaded to Linear and embedded inline in the issue's
   description — see "Images from Slack" below.
6. If someone posts a plain-text reply in that same thread *after* the agent
   already finished (or failed), it's added as a comment on the Linear issue
   and the issue is moved back to the trigger state to resume it — see
   "Resuming a task from Slack" below.

## Architecture

```
src/
  config/       env validation (zod) + SDK client factories (Slack, Linear, GitHub)
  middlewares/  raw-body capture + Slack/Linear HMAC signature verification
  webhooks/     Express controllers: POST /webhooks/slack/commands, POST /webhooks/slack/events, POST /webhooks/linear
  services/     slackService, slackFileService, linearService, linearAssetService, githubService, claudeService (+ Bash guardrails)
  auth/         JWT login — POST /api/auth/login, requireAuth middleware
  dashboard/    GET /api/dashboard — job/PR status as JSON (dashboardService, dashboardRoute)
  types/        Slack slash-command payload, Linear webhook payload
  index.ts      Express app entrypoint
apps/
  dashboard-web/  standalone React/Vite frontend for the dashboard (its own package)
```

One process, one port for the backend. No queue, no polling loop for the
Slack/Linear flow itself — every transition there is driven by an inbound
webhook, and Linear's own issue description is the only place any
cross-request state lives for it. The dashboard is the one part of this repo
that does keep local state (the `jobs` SQLite table) and is polled by the
frontend rather than pushed to.

## Dashboard

Two pieces:

- **Backend API** (this package) — `POST /api/auth/login` (hardcoded
  `DASHBOARD_USERNAME`/`DASHBOARD_PASSWORD` from `.env`, returns a 12h JWT)
  and `GET /api/dashboard` (requires `Authorization: Bearer <token>`,
  returns the job list as JSON). CORS on `/api/*` is restricted to the
  origins listed in `DASHBOARD_CORS_ORIGINS`.
- **Frontend** (`apps/dashboard-web/`) — a separate Vite/React app with a
  login screen and the actual board. Run it locally with `pnpm dev:web`
  (needs `apps/dashboard-web/.env` with `VITE_API_BASE_URL` pointed at this
  backend), or deploy it to Vercel — see `apps/dashboard-web/README.md`.

Jobs are grouped by whose move it is:

- **Your move** — a completed job's PR is still a draft (preview it, then
  mark ready), a required check is failing, there's a merge conflict, a
  reviewer requested changes, the PR is approved and ready to merge, or the
  job itself failed and needs a retry/dismiss decision.
- **Waiting on reviewers** — PR is open, not draft, no blockers — just
  needs a human reviewer's first pass.
- **Automated** — job is queued or the agent is actively drafting. Nothing
  to do.
- **Downstream** — PR merged, awaiting release.

Job status comes from the local queue; PR draft/review/check status is
looked up live from GitHub on every request (so it can drift by up to the
frontend's 60s poll interval).

## Images from Slack

A slash command can't carry a file, so this doesn't work by attaching an
image to `/task` itself. Instead: run `/task`, then **paste or attach an
image as a reply in that same thread**. The server correlates the thread
back to the Linear issue `/task` created (`slack_threads` table — the one
piece of local state this flow keeps, since that link doesn't exist yet at
the point a job would normally provide it), downloads the image with the
bot token, uploads it to Linear's asset storage, and appends it as an inline
markdown image in the issue's description. A confirmation reply lands in
the Slack thread either way (success or failure).

This only works for images posted in a thread `/task` started — anything
else in the channel is ignored. It also only gets the image *into* Linear;
the agent itself still only reads text (title/description/comments), so it
doesn't "see" the picture, just a markdown link to it in the description.

## Resuming a task from Slack

Once a job finishes (draft PR opened, or failed), just reply in that same
Slack thread with what you want changed next — e.g. "there's a bug in the
empty state, please fix it" or "also handle pagination". The server:

1. Looks up the thread's Linear issue (`slack_threads`, same lookup the
   image feature uses).
2. Adds your message as a comment on that issue, so the agent sees it as
   context (`fetchFullIssueContext` includes issue comments) on the next run.
3. Moves the issue back to the trigger state, which fires the same Linear
   webhook a human dragging the card would — enqueuing a fresh run.
4. Replies in-thread once it's done ("Got it — picking this back up now.").

Each run always branches fresh off the current base branch and opens its
own new draft PR (there's no reuse of a previous run's branch/PR — see the
"no chaining" note in `jobRunner.ts`), so a resumed task shows up as a
second draft PR, not a new commit on the first one.

If a message arrives while the previous run for that issue is still
pending/running, it's added as a Linear comment but does **not** trigger a
second concurrent run — it'll just be there as context whenever the issue
is next moved to the trigger state.

This only works for replies in a thread `/task` started; anything else in
the channel is ignored.

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
3. **OAuth & Permissions → Bot Token Scopes** — add `chat:write`, `channels:history`
   (needed to receive message events — used both for the image-forwarding
   feature below and for resuming a task from a plain-text thread reply),
   and `files:read` (needed to download an image someone posts). Install the
   app and copy the **Bot User OAuth Token** (`xoxb-...`) — this is
   `SLACK_BOT_TOKEN`. If you add scopes after already installing, reinstall
   and copy the newly issued token.
4. **Slash Commands → Create New Command**:
   - Command: `/task`
   - Request URL: `https://<your-public-url>/webhooks/slack/commands`
5. **Event Subscriptions** — turn on, set Request URL to
   `https://<your-public-url>/webhooks/slack/events` (Slack calls this
   immediately to verify it — the server handles the handshake, so it should
   show "Verified" right away). Under **Subscribe to bot events**, add
   `message.channels`.
6. Invite the bot to your channel (`/invite @your-bot`), then find the
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
| `DASHBOARD_USERNAME` | yes | Login username for the dashboard |
| `DASHBOARD_PASSWORD` | yes | Login password for the dashboard |
| `DASHBOARD_JWT_SECRET` | yes | Signing key for dashboard login tokens |
| `DASHBOARD_CORS_ORIGINS` | yes | Comma-separated origins allowed to call `/api/*` (the dashboard frontend's URL(s)) |

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
