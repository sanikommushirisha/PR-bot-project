import { startWorker } from "./worker/poll.js";

startWorker().catch((err) => {
  console.error("Worker crashed:", err);
  process.exit(1);
});
