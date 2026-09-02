import { useState } from "react";

const ENTRIES: [string, string][] = [
  ["Queued / In progress", "AI coder drafting."],
  ["Draft", "PR open, still needs your preview before it's ready for review."],
  ["In review", "PR open, awaiting a human reviewer's first pass."],
  ["Changes requested / Checks failing / Conflicts", "Reviewer or CI flagged something."],
  ["Ready to merge", "Approved — merging itself is always a manual click, never automatic."],
  ["Merged", "Awaiting release."],
  ["Failed", "The agent run errored and needs a retry or dismiss decision."],
];

export function Legend() {
  const [open, setOpen] = useState(false);

  return (
    <section className="legend">
      <button type="button" className="btn btn-ghost" onClick={() => setOpen((v) => !v)}>
        {open ? "Hide" : "What do these mean?"} {open ? "▲" : "▼"}
      </button>
      {open && (
        <dl className="legend-list">
          {ENTRIES.map(([term, description]) => (
            <div className="legend-entry" key={term}>
              <dt>{term}</dt>
              <dd>{description}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}
