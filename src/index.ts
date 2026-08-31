import Fastify from "fastify";
import { config } from "./config/index.js";
import { getDb, Jobs } from "./db/index.js";
import { createBot } from "./slack/index.js";

async function main() {
  const db = getDb(config.worker.dbPath);
  const app = Fastify({ logger: true });

  app.get("/health", async () => ({ status: "ok" }));

  app.get<{ Params: { id: string } }>("/jobs/:id", async (request, reply) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id)) {
      return reply.status(400).send({ error: "Invalid job id" });
    }

    const job = Jobs.getById(db, id);
    if (!job) {
      return reply.status(404).send({ error: "Job not found" });
    }

    return job;
  });

  const bot = createBot(db);

  await app.listen({ port: config.server.port, host: "0.0.0.0" });
  console.log(`Fastify API listening on port ${config.server.port}.`);

  await bot.start();
  console.log("Slack app connected via Socket Mode.");

  const shutdown = async () => {
    console.log("Shutting down bot+API server...");
    await bot.stop();
    await app.close();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Failed to start bot+API server:", err);
  process.exit(1);
});
