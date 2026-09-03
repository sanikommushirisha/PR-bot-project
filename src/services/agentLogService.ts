/**
 * In-memory activity log for a running job, keyed by job id. Only one job
 * ever runs at a time in this process (see jobRunner's isRunnerActive guard),
 * so there's no need to persist this to disk — it exists purely so the
 * dashboard can poll "what is Claude doing right now" for the job currently
 * in progress. The caller clears a job's entries once it finishes (see
 * jobRunner's processJob finally block), so this never grows unbounded.
 */

export interface AgentLogEntry {
  seq: number;
  timestamp: string;
  text: string;
}

const logsByJobId = new Map<number, AgentLogEntry[]>();
let seqCounter = 0;

// Caps memory for a single very chatty/long-running job — old entries roll
// off the front once exceeded, favoring recent activity over full history.
const MAX_ENTRIES_PER_JOB = 500;

function append(jobId: number, text: string): void {
  const trimmed = text.trim();
  if (!trimmed) return;

  const entries = logsByJobId.get(jobId) ?? [];
  entries.push({ seq: ++seqCounter, timestamp: new Date().toISOString(), text: trimmed });
  if (entries.length > MAX_ENTRIES_PER_JOB) entries.shift();
  logsByJobId.set(jobId, entries);
}

function getSince(jobId: number, afterSeq: number): AgentLogEntry[] {
  const entries = logsByJobId.get(jobId);
  if (!entries) return [];
  return entries.filter((entry) => entry.seq > afterSeq);
}

function clear(jobId: number): void {
  logsByJobId.delete(jobId);
}

export const AgentLogs = { append, getSince, clear };
