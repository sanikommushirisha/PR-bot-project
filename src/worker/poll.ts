import { WebClient } from "@slack/web-api";
import { config } from "../config/index.js";
import { getDb, Jobs } from "../db/index.js";
import { processJob } from "./pipeline.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function startWorker(): Promise<void> {
  const db = getDb(config.worker.dbPath);
  const slack = new WebClient(config.slack.botToken);

  const { requeued, failed } = Jobs.resetStuck(db, config.worker.stuckJobTimeoutMs);
  if (requeued || failed) {
    console.log(
      `Startup recovery: requeued ${requeued} stuck job(s), marked ${failed} job(s) failed past the retry limit.`
    );
  }

  console.log(`Worker started. Polling every ${config.worker.pollIntervalMs}ms.`);

  let stopped = false;
  const shutdown = () => {
    console.log("Worker shutting down after current job (if any)...");
    stopped = true;
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  while (!stopped) {
    const job = Jobs.claimNextPending(db);
    if (!job) {
      await sleep(config.worker.pollIntervalMs);
      continue;
    }

    console.log(`Claimed job #${job.id}: ${job.taskDescription}`);
    await processJob(job, { db, slack });
    console.log(`Finished job #${job.id}`);
  }
}
