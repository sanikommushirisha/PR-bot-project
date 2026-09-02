function parseTimestamp(value: string): Date {
  // SQLite's datetime('now') yields "YYYY-MM-DD HH:MM:SS" with no timezone — it's UTC.
  const normalized = value.includes("T") || value.endsWith("Z") ? value : `${value.replace(" ", "T")}Z`;
  return new Date(normalized);
}

export function formatElapsed(value: string): string {
  const ms = Date.now() - parseTimestamp(value).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}
