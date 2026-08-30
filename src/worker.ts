import { env } from "./config/index.js";

// Placeholder worker entrypoint. BullMQ worker wiring lands once the GitHub
// and Claude modules are confirmed working (see README).
console.log(`telegram-agent-bridge worker starting (env: ${env.NODE_ENV})`);
