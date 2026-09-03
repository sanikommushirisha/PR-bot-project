import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../auth/AuthContext";
import { ApiError, deleteIntegrationErrors, fetchIntegrationErrors } from "../api/client";
import { INTEGRATION_SOURCE_LABEL, type IntegrationErrorEntry } from "../types";

const POLL_INTERVAL_MS = 30_000;

export function IntegrationErrorsPanel() {
  const { logout } = useAuth();
  const [errors, setErrors] = useState<IntegrationErrorEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await fetchIntegrationErrors();
      setErrors(data.errors);
      setError(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        logout();
        return;
      }
      setError(err instanceof ApiError ? err.message : "Couldn't reach the server.");
    }
  }, [logout]);

  useEffect(() => {
    load();
    const interval = setInterval(load, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [load]);

  async function handleClearAll() {
    setClearing(true);
    try {
      await deleteIntegrationErrors();
      setErrors([]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't clear errors.");
    } finally {
      setClearing(false);
    }
  }

  return (
    <section className="lane errors-panel">
      <div className="lane-header">
        <span className="dot dot-errors" />
        <h2 className="lane-label">Integration errors</h2>
        <span className="lane-count">{errors?.length ?? 0}</span>
        <span className="lane-desc">recent Claude / GitHub / Linear failures, most recent first</span>
        {errors && errors.length > 0 && (
          <button type="button" className="btn btn-small btn-ghost errors-clear-all" onClick={handleClearAll} disabled={clearing}>
            {clearing ? "Clearing…" : "Clear all"}
          </button>
        )}
      </div>

      {error && <div className="status-banner status-error">{error}</div>}

      <div className="lane-body">
        {errors == null ? (
          <div className="empty">Loading…</div>
        ) : errors.length === 0 ? (
          <div className="empty">No integration errors in the last 2 days.</div>
        ) : (
          errors.map((entry) => (
            <div key={entry.id} className="card error-card">
              <div className="card-row">
                <span className={`pill pill-source pill-source-${entry.source}`}>
                  {INTEGRATION_SOURCE_LABEL[entry.source]}
                </span>
                {entry.jobIdentifier && <span className="card-id">{entry.jobIdentifier}</span>}
                <span className="card-time">{new Date(entry.createdAt).toLocaleString()}</span>
              </div>
              <div className="card-row card-meta">
                <span className="card-reason error-message">{entry.message}</span>
              </div>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
