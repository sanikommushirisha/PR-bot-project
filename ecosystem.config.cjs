// PM2 process definition for the backend only. The dashboard frontend is a
// static SPA (see apps/dashboard-web) — it has no server process, nginx
// serves its built files directly, so it does not belong here.
//
// `.cjs` extension is required: package.json sets "type": "module", and PM2
// config files must be CommonJS.
//
// Usage: pm2 start ecosystem.config.cjs
module.exports = {
  apps: [
    {
      name: "pr-bot-backend",
      script: "dist/index.js",
      cwd: __dirname,
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      max_restarts: 10,
      // .env is loaded by src/config/env.ts (dotenv) from process.cwd() at
      // startup — no secrets need to be duplicated here.
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
