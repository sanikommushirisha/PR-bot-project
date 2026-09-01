import type { NextFunction, Request, Response } from "express";
import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "../config/env.js";

const MAX_TIMESTAMP_SKEW_SECONDS = 60 * 5;

/**
 * Verifies Slack's request signature per https://api.slack.com/authentication/verifying-requests-from-slack
 * Requires `req.rawBody` to have been captured by the raw-body-saving JSON/urlencoded parser
 * before this runs.
 */
export function verifySlackSignature(req: Request, res: Response, next: NextFunction): void {
  const timestamp = req.header("X-Slack-Request-Timestamp");
  const signature = req.header("X-Slack-Signature");
  const rawBody = req.rawBody;

  if (!timestamp || !signature || !rawBody) {
    console.warn(`Rejected Slack request: missing signature headers (path: ${req.path}).`);
    res.status(400).send("Missing Slack signature headers.");
    return;
  }

  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > MAX_TIMESTAMP_SKEW_SECONDS) {
    console.warn(`Rejected Slack request: timestamp too old (age ${age}s).`);
    res.status(400).send("Slack request timestamp too old — possible replay.");
    return;
  }

  const baseString = `v0:${timestamp}:${rawBody.toString("utf8")}`;
  const expected = `v0=${createHmac("sha256", config.slack.signingSecret).update(baseString).digest("hex")}`;

  const expectedBuf = Buffer.from(expected, "utf8");
  const actualBuf = Buffer.from(signature, "utf8");

  if (expectedBuf.length !== actualBuf.length || !timingSafeEqual(expectedBuf, actualBuf)) {
    console.warn("Rejected Slack request: signature mismatch — check SLACK_SIGNING_SECRET.");
    res.status(401).send("Invalid Slack signature.");
    return;
  }

  next();
}
