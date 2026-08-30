module.exports = {
  apps: [
    {
      name: "telegram-agent-bridge-bot",
      script: "dist/index.js",
      cwd: __dirname,
      env: { NODE_ENV: "production" },
      autorestart: true,
    },
    {
      name: "telegram-agent-bridge-worker",
      script: "dist/worker.js",
      cwd: __dirname,
      env: { NODE_ENV: "production" },
      autorestart: true,
    },
  ],
};
