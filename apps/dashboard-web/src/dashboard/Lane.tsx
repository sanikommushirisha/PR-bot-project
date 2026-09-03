import type { DashboardCard, LaneKey } from "../types";
import { LANE_META } from "../types";
import { Card } from "./Card";

const LANE_DOT_CLASS: Record<LaneKey, string> = {
  your_move: "dot-your-move",
  waiting_on_reviewers: "dot-waiting",
  automated: "dot-automated",
  downstream: "dot-downstream",
};

export function Lane({
  laneKey,
  cards,
  onViewLogs,
}: {
  laneKey: LaneKey;
  cards: DashboardCard[];
  onViewLogs: (jobId: number) => void;
}) {
  const meta = LANE_META[laneKey];

  return (
    <section className="lane">
      <div className="lane-header">
        <span className={`dot ${LANE_DOT_CLASS[laneKey]}`} />
        <h2 className="lane-label">{meta.label}</h2>
        <span className="lane-count">{cards.length}</span>
        <span className="lane-desc">{meta.description}</span>
      </div>
      <div className="lane-body">
        {cards.length === 0 ? (
          <div className="empty">Nothing here right now.</div>
        ) : (
          cards.map((card) => (
            <Card key={`${card.identifier}-${card.prNumber ?? "job"}`} card={card} onViewLogs={onViewLogs} />
          ))
        )}
      </div>
    </section>
  );
}
