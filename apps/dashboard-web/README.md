# dashboard-web

Standalone frontend for the job dashboard — a login screen plus the board
itself, grouped by whose move it is next. Talks to the `slack-linear-claude-agent`
backend's `POST /api/auth/login` and `GET /api/dashboard` (see the root
README's "Dashboard" section).

## Local development

```bash
cp .env.example .env   # set VITE_API_BASE_URL to your local/deployed backend
pnpm dev:web            # from the repo root — runs this package's `vite`
```

The backend must have this app's origin (`http://localhost:5173` in dev) in
its `DASHBOARD_CORS_ORIGINS`, and `DASHBOARD_USERNAME`/`DASHBOARD_PASSWORD`
set for the login form to accept anything.

## Deploying to Vercel

This repo is a pnpm workspace; this package is one member of it
(`apps/dashboard-web`). To deploy just this app:

1. In Vercel, **Add New → Project**, import this GitHub repo.
2. Under **Root Directory**, select `apps/dashboard-web`. Vercel will pick
   up `vercel.json` here (build command `pnpm build`, output `dist`,
   framework `vite`).
3. Add an environment variable `VITE_API_BASE_URL` pointing at your
   backend's public URL (it must be reachable from the browser — an ngrok
   tunnel works for testing, but it changes on every restart, so anyone
   using the deployed link would need the backend's URL to stay stable, or
   you'll need to update this env var and redeploy each time it changes).
4. Deploy. Add the resulting `https://<project>.vercel.app` origin to the
   backend's `DASHBOARD_CORS_ORIGINS` and restart the backend.

Anyone with the Vercel URL can open the login screen; only whoever knows
`DASHBOARD_USERNAME`/`DASHBOARD_PASSWORD` can actually see the board.
