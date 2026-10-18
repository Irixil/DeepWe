export type ClientAnalyticsEventName =
  | "app_opened"
  | "screen_viewed"
  | "screen_left"
  | "guide_stage_viewed"
  | "guide_ended"
  | "conversation_created"
  | "conversation_message_sent"
  | "conversation_share_prepared"
  | "conversation_share_confirmed"
  | "conversation_deleted"
  | "ai_stopped"
  | "ai_retried"
  | "message_feedback_submitted"
  | "core_outcome_submitted"
  | "request_failed";

export interface ClientAnalyticsEvent {
  name: ClientAnalyticsEventName;
  eventId?: string;
  screen?: "auth" | "home" | "couple" | "records" | "me" | "event" | "conversation" | "admin";
  step?: string;
  result?: string;
  reason?: string;
  durationMs?: number;
}

const SESSION_KEY = "deepwe-experience-session";
let memorySessionId = "";

export function getAnalyticsSessionId(): string {
  if (typeof window === "undefined") return "";
  if (memorySessionId) return memorySessionId;
  let saved: string | null = null;
  try {
    saved = window.sessionStorage.getItem(SESSION_KEY);
  } catch {
    // Optional statistics storage must never block account or conversation APIs.
  }
  if (saved) {
    memorySessionId = saved;
    return saved;
  }
  memorySessionId = window.crypto.randomUUID();
  try {
    window.sessionStorage.setItem(SESSION_KEY, memorySessionId);
  } catch {
    // Keep the same identifier in memory when browser storage is unavailable.
  }
  return memorySessionId;
}

export async function trackAnalytics(event: ClientAnalyticsEvent): Promise<boolean> {
  const sessionId = getAnalyticsSessionId();
  if (!sessionId) return false;
  try {
    const response = await fetch("/api/analytics/events", {
      method: "POST",
      credentials: "include",
      keepalive: true,
      headers: {
        "Content-Type": "application/json",
        "X-DeepWe-Session": sessionId,
      },
      body: JSON.stringify(event),
    });
    if (!response.ok) return false;
    const data = await response.json().catch(() => ({})) as { recorded?: boolean };
    return data.recorded !== false;
  } catch {
    return false;
  }
}

export function trackAnalyticsBestEffort(event: ClientAnalyticsEvent): void {
  void trackAnalytics(event);
}
