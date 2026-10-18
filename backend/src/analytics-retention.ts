import { ANALYTICS_RETENTION_MS, db, pruneExpiredAnalytics } from "./db.js";

// This uses the existing backend process; it does not run while that process is
// stopped or frozen. Startup catches up before the first persistence snapshot.
export const ANALYTICS_RETENTION_INTERVAL_MS = 60 * 60 * 1000;
let timer: ReturnType<typeof setTimeout> | undefined;

function scheduleNextCheck(): void {
  const { earliestCreatedAt } = db.prepare(`SELECT MIN(created_at) earliestCreatedAt FROM (
    SELECT MIN(created_at) created_at FROM analytics_events
    UNION ALL SELECT MIN(created_at) created_at FROM ai_call_metrics
  )`).get() as { earliestCreatedAt: number | null };
  const remaining = earliestCreatedAt === null
    ? ANALYTICS_RETENTION_INTERVAL_MS
    : earliestCreatedAt + ANALYTICS_RETENTION_MS - Date.now();
  const delay = Math.max(1, Math.min(ANALYTICS_RETENTION_INTERVAL_MS, remaining));
  timer = setTimeout(cleanupAndReschedule, delay);
  timer.unref();
}

function cleanupAndReschedule(): void {
  timer = undefined;
  try {
    pruneExpiredAnalytics();
    scheduleNextCheck();
  } catch {
    // No private data, SQL, or exception body is written to logs.
    console.error("Analytics retention cleanup failed; retrying on the next interval");
    timer = setTimeout(cleanupAndReschedule, ANALYTICS_RETENTION_INTERVAL_MS);
    timer.unref();
  }
}

export function startAnalyticsRetention(): void {
  if (timer) return;
  pruneExpiredAnalytics();
  scheduleNextCheck();
}

export function stopAnalyticsRetention(): void {
  if (timer) clearTimeout(timer);
  timer = undefined;
}
