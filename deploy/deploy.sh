#!/usr/bin/env bash
# Redeploys both the backend (PM2) and the dashboard frontend (static build,
# served directly by nginx — no process to restart for it) on the EC2 host.
# Run from the repo root: ./deploy/deploy.sh
set -euo pipefail

cd "$(dirname "$0")/.."

git pull --ff-only
pnpm install --frozen-lockfile

pnpm run build       # backend -> dist/
pnpm run build:web   # frontend -> apps/dashboard-web/dist/ (nginx serves this path directly)

pm2 reload ecosystem.config.cjs --update-env
