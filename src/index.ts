import { env } from "./config/index.js";

// Placeholder entrypoint. Fastify server + Telegram bot (grammy) wiring lands
// once the GitHub and Claude modules are confirmed working (see README).
console.log(`telegram-agent-bridge server starting (env: ${env.NODE_ENV}, port: ${env.PORT})`);
