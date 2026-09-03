import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../auth/AuthContext";
import { ApiError, fetchDashboard } from "../api/client";
import { LANE_ORDER, type DashboardLanes } from "../types";
import { Lane } from "./Lane";
import { Legend } from "./Legend";
import { LogsModal } from "./LogsModal";

const POLL_INTERVAL_MS = 60_000;

export function DashboardPage() {
  const { logout } = useAuth();
  const [lanes, setLanes] = useState<DashboardLanes | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [viewingJobId, setViewingJobId] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await fetchDashboard();
      setLanes(data);
      setError(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        logout();
        return;
      }
      setError(err instanceof ApiError ? err.message : "Couldn't reach the server.");
    } finally {
      setLoading(false);
    }
  }, [logout]);

  useEffect(() => {
    load();
    const interval = setInterval(load, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [load]);

  return (
    <div className="dashboard">
      <header className="dashboard-header">
        <div>
          <h1>Job dashboard</h1>
          <p className="dashboard-subtitle">
            Grouped by whose move it is next.
            {lanes && ` Last updated ${new Date(lanes.generatedAt).toLocaleTimeString()}.`}
          </p>
        </div>
        <div className="dashboard-actions">
          <button
            type="button"
            className="btn"
            onClick={() => {
              setLoading(true);
              load();
            }}
          >
            Refresh
          </button>
          <button type="button" className="btn btn-ghost" onClick={logout}>
            Log out
          </button>
        </div>
      </header>

      {loading && !lanes && <div className="status-banner">Loading…</div>}
      {error && <div className="status-banner status-error">{error}</div>}

      {lanes && (
        <>
          {LANE_ORDER.map((key) => (
            <Lane key={key} laneKey={key} cards={lanes[key]} onViewLogs={setViewingJobId} />
          ))}
          <Legend />
        </>
      )}

      {viewingJobId != null && <LogsModal jobId={viewingJobId} onClose={() => setViewingJobId(null)} />}
    </div>
  );
}
