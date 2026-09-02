import type { DashboardCard } from "../types";
import { formatElapsed } from "./format";

export function Card({ card }: { card: DashboardCard }) {
  return (
    <div className="card">
      <div className="card-row">
        <span className="pill pill-stage">{card.stage}</span>
        <span className="card-id">{card.identifier}</span>
        <span className="card-title">{card.title}</span>
      </div>
      <div className="card-row card-meta">
        <span className="card-reason">{card.reason}</span>
        <span className="card-time">{formatElapsed(card.timestamp)} in stage</span>
        {card.prUrl && (
          <a className="btn btn-small" href={card.prUrl} target="_blank" rel="noopener noreferrer">
            View PR #{card.prNumber} ↗
          </a>
        )}
      </div>
    </div>
  );
}
