#!/usr/bin/env bash
# Redeploys both the backend (PM2) and the dashboard frontend (static build,
# synced to /var/www/bot, served directly by nginx — no process to restart
# for it) on the EC2 host. Run from the repo root: ./deploy/deploy.sh
set -euo pipefail

cd "$(dirname "$0")/.."

git pull --ff-only
pnpm install --frozen-lockfile

pnpm run build       # backend -> dist/
pnpm run build:web   # frontend -> apps/dashboard-web/dist/

# nginx runs as www-data, which can't traverse into /home/ubuntu (mode 750),
# so the build is synced out to /var/www/bot (world-readable, matches the
# rest of this host's nginx-served static content) rather than served
# straight from the repo. See /etc/nginx/sites-available/lesser.tax's
# `location /bot/` block.
rsync -a --delete apps/dashboard-web/dist/ /var/www/bot/

pm2 reload ecosystem.config.cjs --update-env
