import { env } from "./config/index.js";

// Placeholder entrypoint. Fastify server + Slack Bolt app wiring lands once
// the GitHub and Claude modules are confirmed working (see README).
console.log(`slack-agent-bridge server starting (env: ${env.NODE_ENV}, port: ${env.PORT})`);
