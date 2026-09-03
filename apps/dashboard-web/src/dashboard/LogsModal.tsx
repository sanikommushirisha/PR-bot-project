import { useEffect, useRef, useState } from "react";
import { ApiError, fetchJobLogs } from "../api/client";
import type { JobLogEntry } from "../types";

const POLL_INTERVAL_MS = 2000;
const ACTIVE_STATUSES = new Set(["pending", "running"]);

export function LogsModal({ jobId, onClose }: { jobId: number; onClose: () => void }) {
  const [logs, setLogs] = useState<JobLogEntry[]>([]);
  const [status, setStatus] = useState("running");
  const [error, setError] = useState<string | null>(null);
  const lastSeqRef = useRef(0);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    async function poll() {
      try {
        const data = await fetchJobLogs(jobId, lastSeqRef.current);
        if (cancelled) return;

        if (data.logs.length > 0) {
          lastSeqRef.current = data.logs[data.logs.length - 1].seq;
          setLogs((prev) => [...prev, ...data.logs]);
        }
        setStatus(data.status);
        setError(null);

        if (ACTIVE_STATUSES.has(data.status)) {
          timer = setTimeout(poll, POLL_INTERVAL_MS);
        }
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof ApiError ? err.message : "Couldn't reach the server.");
        timer = setTimeout(poll, POLL_INTERVAL_MS);
      }
    }

    poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [jobId]);

  useEffect(() => {
    if (bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    }
  }, [logs]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Live activity — job #{jobId}</h2>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Close
          </button>
        </div>

        {error && <div className="status-banner status-error">{error}</div>}

        <div className="modal-body log-body" ref={bodyRef}>
          {logs.length === 0 ? (
            <div className="log-empty">Waiting for activity…</div>
          ) : (
            logs.map((entry) => (
              <div key={entry.seq} className="log-line">
                <span className="log-time">{new Date(entry.timestamp).toLocaleTimeString()}</span>
                <span className="log-text">{entry.text}</span>
              </div>
            ))
          )}
        </div>

        <div className="modal-footer">
          {ACTIVE_STATUSES.has(status) ? "Live — polling…" : `Job ${status}. No longer updating.`}
        </div>
      </div>
    </div>
  );
}
