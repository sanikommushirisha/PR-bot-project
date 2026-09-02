# Deploying to EC2

Both pieces run on one EC2 instance, no containers:

- **Backend** (this package) — a long-running Node process, managed by
  **PM2** (`ecosystem.config.cjs`), listening on `127.0.0.1:3000`.
- **Frontend** (`apps/dashboard-web`) — a static SPA. It has **no server
  process** — `pnpm build:web` produces `apps/dashboard-web/dist/`, and
  **nginx serves those files directly**. Nothing to run under PM2 for it.

**nginx** sits in front of both as the reverse proxy + TLS terminator (this
was already required per the root README — Slack/Linear webhooks need a
real public HTTPS URL, `localhost`/plain HTTP won't work).

This setup uses two subdomains (matches how the app already separates
origins via `DASHBOARD_CORS_ORIGINS`/`VITE_API_BASE_URL`):

- `api.yourdomain.com` → backend
- `app.yourdomain.com` → frontend

If you'd rather use one domain with a path split instead of two subdomains,
flag that — it changes the nginx config and the CORS/API-base-URL values
below.

## 1. One-time server setup

On a fresh Ubuntu EC2 instance (security group: 22, 80, 443 open; an
Elastic IP is strongly recommended so DNS doesn't break on restart):

```bash
sudo apt update
sudo apt install -y nginx git certbot python3-certbot-nginx

# Node 20 (NodeSource)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

corepack enable
corepack prepare pnpm@9.15.4 --activate

sudo npm install -g pm2
```

## 2. Clone and configure

```bash
git clone <this-repo-url> pr-bot
cd pr-bot

cp .env.example .env
# fill in real secrets; set:
#   DASHBOARD_CORS_ORIGINS=https://app.yourdomain.com
#   PORT=3000

cp apps/dashboard-web/.env.example apps/dashboard-web/.env
# set VITE_API_BASE_URL=https://api.yourdomain.com
# (Vite bakes this into the static bundle at build time — it must be the
# backend's real public URL before you run build:web)

pnpm install --frozen-lockfile
pnpm run build       # backend -> dist/
pnpm run build:web   # frontend -> apps/dashboard-web/dist/
```

## 3. Start the backend under PM2

```bash
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup   # run the systemd command it prints, so PM2 survives reboots
```

## 4. nginx + TLS

```bash
# Copy the two server blocks from deploy/nginx.conf.example, replacing:
#   api.yourdomain.com / app.yourdomain.com -> your real domains
#   /home/ubuntu/pr-bot                     -> this repo's absolute path
sudo cp deploy/nginx.conf.example /etc/nginx/sites-available/pr-bot
sudo ln -s /etc/nginx/sites-available/pr-bot /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default   # if present, avoids a conflicting default_server
sudo nginx -t && sudo systemctl reload nginx
```

Point both domains' DNS **A** records at the instance's Elastic IP, then:

```bash
sudo certbot --nginx -d api.yourdomain.com -d app.yourdomain.com
```

Certbot edits the nginx config in place to add HTTPS + an HTTP→HTTPS
redirect, and installs its own renewal timer.

## 5. Point Slack/Linear at the backend

Use `https://api.yourdomain.com/webhooks/slack/commands`,
`https://api.yourdomain.com/webhooks/slack/events`, and
`https://api.yourdomain.com/webhooks/linear` as the Request URLs (see root
README's "Setting up Slack/Linear" sections).

## 6. Verify

```bash
curl https://api.yourdomain.com/health   # {"status":"ok"}
```

Open `https://app.yourdomain.com`, log in with
`DASHBOARD_USERNAME`/`DASHBOARD_PASSWORD`.

## Updating

```bash
./deploy/deploy.sh
```

Pulls `main`, rebuilds both, `pm2 reload`s the backend. No nginx reload
needed for frontend changes — it just serves whatever's currently in
`apps/dashboard-web/dist`.

## Operations

- Backend logs: `pm2 logs pr-bot-backend`, status: `pm2 status`
- nginx logs: `/var/log/nginx/error.log`, `/var/log/nginx/access.log`
- Data lives directly on disk now, no volumes: `data/jobs.sqlite` (the job
  queue) and `scratch/` (per-job repo clones, safe to clear if it grows).
  Back up `data/jobs.sqlite` periodically if you care about job history.
