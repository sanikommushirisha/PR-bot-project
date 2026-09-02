import express from "express";
import cors from "cors";
import { config } from "./config/env.js";
import { saveRawBody } from "./middlewares/rawBody.js";
import { verifySlackSignature } from "./middlewares/verifySlackSignature.js";
import { verifyLinearSignature } from "./middlewares/verifyLinearSignature.js";
import { createSlackCommandsHandler } from "./webhooks/slackCommands.js";
import { createSlackEventsHandler } from "./webhooks/slackEvents.js";
import { createLinearWebhookHandler } from "./webhooks/linearEvents.js";
import { resolveTeam } from "./services/linearService.js";
import { getDb, Jobs } from "./db/index.js";
import { kickRunner } from "./services/jobRunner.js";
import { createDashboardHandler } from "./dashboard/dashboardRoute.js";
import { createLoginHandler } from "./auth/authRoute.js";
import { requireAuth } from "./auth/authMiddleware.js";

const STUCK_JOB_TIMEOUT_MS = 30 * 60 * 1000;

async function main() {
  const app = express();
  const db = getDb(config.worker.dbPath);

  const { requeued, failed } = Jobs.resetStuck(db, STUCK_JOB_TIMEOUT_MS);
  if (requeued || failed) {
    console.log(`Startup recovery: requeued ${requeued} stuck job(s), marked ${failed} job(s) failed past the retry limit.`);
  }

  app.get("/health", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  // Slack slash commands are delivered as application/x-www-form-urlencoded,
  // not JSON. The raw body must be captured before parsing for signature
  // verification, so each route gets its own scoped parser (a global one
  // would break the other route's content type).
  const slackCommandsHandler = createSlackCommandsHandler(db);
  app.post(
    "/webhooks/slack/commands",
    express.urlencoded({ extended: true, verify: saveRawBody }),
    verifySlackSignature,
    (req, res) => {
      slackCommandsHandler(req, res).catch((err) => {
        console.error("Unhandled error in Slack command handler:", err);
      });
    }
  );

  app.post(
    "/webhooks/linear",
    express.json({ verify: saveRawBody }),
    verifyLinearSignature,
    createLinearWebhookHandler(db)
  );

  // Slack Events API — currently only used to catch an image posted in a
  // thread /task registered, so it can be forwarded to the Linear issue.
  app.post(
    "/webhooks/slack/events",
    express.json({ verify: saveRawBody }),
    verifySlackSignature,
    createSlackEventsHandler(db)
  );

  // The dashboard frontend is a separately deployed app (apps/dashboard-web)
  // on its own origin, so only these two API routes need CORS.
  app.use("/api", cors({ origin: config.dashboard.corsOrigins }));
  app.post("/api/auth/login", express.json(), createLoginHandler());
  app.get("/api/dashboard", requireAuth, createDashboardHandler(db));

  // Linear is resolved once at startup purely to fail loudly and early if
  // LINEAR_TEAM_KEY is wrong — the service layer caches the result, so this
  // also warms the cache before the first real webhook arrives.
  try {
    const team = await resolveTeam();
    console.log(`Linear team resolved: ${team.key} (${team.id}).`);
  } catch (err) {
    console.error("Could not resolve Linear team at startup:", err instanceof Error ? err.message : err);
  }

  // Pick back up on anything left `pending` from before a restart (e.g. a
  // job enqueued right before the process was killed).
  kickRunner(db);

  // Catches a misconfigured Request URL (e.g. Slack/Linear pointed at the
  // wrong path) loudly instead of silently 404ing with nothing logged.
  app.use((req, res) => {
    console.warn(`404: no route for ${req.method} ${req.path} — check the Request URL configured in Slack/Linear.`);
    res.status(404).send("Not found.");
  });

  app.listen(config.server.port, "0.0.0.0", () => {
    console.log(`slack-linear-claude-agent listening on port ${config.server.port}.`);
    console.log(`  Slack commands: POST /webhooks/slack/commands`);
    console.log(`  Slack events:   POST /webhooks/slack/events`);
    console.log(`  Linear events:  POST /webhooks/linear`);
    console.log(`  Dashboard API:  POST /api/auth/login, GET /api/dashboard (Bearer token)`);
  });
}

main().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
