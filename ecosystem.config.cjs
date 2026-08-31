module.exports = {
  apps: [
    {
      name: "slack-agent-bridge-bot",
      script: "dist/index.js",
      cwd: __dirname,
      env: { NODE_ENV: "production" },
      autorestart: true,
    },
    {
      name: "slack-agent-bridge-worker",
      script: "dist/worker.js",
      cwd: __dirname,
      env: { NODE_ENV: "production" },
      autorestart: true,
    },
  ],
};
