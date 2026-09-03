import type { ActivitySource } from "../db/activityLogs.js";

/**
 * An error tagged with which external integration it came from. Thrown by
 * the Linear/GitHub/Claude service layers at their real API boundaries, then
 * caught once at the orchestration layer (jobRunner, dashboardService,
 * startup) and persisted via ActivityLogs — so the dashboard can tell you
 * not just that something failed, but which integration failed.
 */
export class IntegrationError extends Error {
  readonly source: ActivitySource;

  constructor(source: ActivitySource, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "IntegrationError";
    this.source = source;
  }
}

/** Wraps any thrown value as an IntegrationError tagged with `source`, prefixing `context` and preserving the original as `cause`. */
export function toIntegrationError(source: ActivitySource, context: string, err: unknown): IntegrationError {
  if (err instanceof IntegrationError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new IntegrationError(source, `${context}: ${message}`, { cause: err });
}

/** Best-effort source attribution for any caught error — IntegrationError carries its own, anything else is "system" (an uncaught bug, not a specific integration). */
export function integrationSourceOf(err: unknown): ActivitySource {
  return err instanceof IntegrationError ? err.source : "system";
}
