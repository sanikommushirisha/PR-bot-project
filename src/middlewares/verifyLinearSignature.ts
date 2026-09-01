import type { NextFunction, Request, Response } from "express";
import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "../config/env.js";

/**
 * Verifies Linear's webhook signature per https://linear.app/developers/webhooks
 * (HMAC-SHA256 hex digest of the raw body, in the `Linear-Signature` header).
 * Requires `req.rawBody` to have been captured by the raw-body-saving JSON
 * parser before this runs.
 */
export function verifyLinearSignature(req: Request, res: Response, next: NextFunction): void {
  const signature = req.header("Linear-Signature");
  const rawBody = req.rawBody;

  if (!signature || !rawBody) {
    console.warn(`Rejected Linear webhook: missing signature header (path: ${req.path}).`);
    res.status(400).send("Missing Linear signature header.");
    return;
  }

  const expected = createHmac("sha256", config.linear.webhookSecret).update(rawBody).digest("hex");

  const expectedBuf = Buffer.from(expected, "utf8");
  const actualBuf = Buffer.from(signature, "utf8");

  if (expectedBuf.length !== actualBuf.length || !timingSafeEqual(expectedBuf, actualBuf)) {
    console.warn("Rejected Linear webhook: signature mismatch — check LINEAR_WEBHOOK_SECRET.");
    res.status(401).send("Invalid Linear signature.");
    return;
  }

  next();
}
