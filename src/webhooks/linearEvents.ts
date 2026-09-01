import type { Request, Response } from "express";
import type Database from "better-sqlite3";
import { config } from "../config/env.js";
import type { LinearWebhookPayload } from "../types/linear.js";
import { Jobs } from "../db/index.js";
import { parseSlackMetaMarker } from "../services/slackService.js";
import { kickRunner } from "../services/jobRunner.js";

export function createLinearWebhookHandler(db: Database.Database) {
  return async function handleLinearWebhook(req: Request, res: Response): Promise<void> {
    const payload = req.body as LinearWebhookPayload;

    // Ack immediately — the actual work (enqueue + maybe kick the runner) is
    // fast, but there's no reason to make Linear wait on it either.
    res.status(200).send();

    if (payload.type !== "Issue" || payload.action !== "update" || !payload.updatedFrom) return;

    // Priority changed on an issue still waiting its turn — sync it into the
    // queue so it can actually affect scheduling. No-ops if the job isn't
    // currently `pending` (already running/finished jobs aren't reordered).
    if ("priority" in payload.updatedFrom && typeof payload.data.priority === "number") {
      const updated = Jobs.setPriorityIfPending(db, payload.data.id, payload.data.priority);
      if (updated) {
        console.log(
          `Priority for queued job (${payload.data.identifier}) updated to ${payload.data.priority}.`
        );
      }
    }

    if (!("stateId" in payload.updatedFrom)) return; // only enqueue on an actual state transition

    const newStateName = payload.data.state?.name;
    if (newStateName !== config.linear.triggerStateName) return;

    const slackMeta = parseSlackMetaMarker(payload.data.description);

    const { job, created } = Jobs.enqueue(db, {
      linearIssueId: payload.data.id,
      linearIssueIdentifier: payload.data.identifier,
      linearIssueTitle: payload.data.title,
      linearIssueDescription: payload.data.description ?? null,
      channelId: slackMeta?.channelId ?? null,
      threadTs: slackMeta?.threadTs ?? null,
    });

    if (!created) {
      console.log(
        `${payload.data.identifier} moved to "${newStateName}" but is already queued/running as job #${job.id} — ignoring duplicate trigger.`
      );
      return;
    }

    console.log(`${payload.data.identifier} moved to "${newStateName}" — enqueued as job #${job.id}.`);
    kickRunner(db);
  };
}
