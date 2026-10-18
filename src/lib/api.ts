// 前端 API 客户端：所有后端调用集中在这里。
// 本地开发直连后端；部署后改为同源代理（见 next.config rewrites）。

import type {
  AccountEventSummary,
  AccountUser,
  AdminAnalyticsDashboard,
  AdminRegistrationInvite,
  EventData,
  PrivateConversation,
  PrivateConversationDetail,
  PrivateShareDraft,
  PrivateJobResult,
  PrivateMessage,
  PrivateNote,
  PrivateReplyFeedback,
  ReplyFeedbackReason,
  PartnerInvite,
  PartnerOverview,
  SharedMemoryCategory,
  SharedSpaceOverview,
} from "./types";
import { getAnalyticsSessionId, trackAnalyticsBestEffort } from "./analytics";
import { getAccountSessionRevision, notifyAccountSessionChanged } from "./account-session";

export type PrivateMemoryKind = "user_statement" | "tentative_understanding" | "unknown" | string;

export type PrivateMemorySource = {
  sourceConversationId: string;
  sourceMessageIds: string[];
  sourceMessageVersions: Record<string, number>;
};

export type PrivateMemorySupersededSource = PrivateMemorySource & {
  memoryItemId: string;
  itemVersion: number;
};

export type PrivateMemoryItem = {
  id: string;
  kind: PrivateMemoryKind;
  content: string;
  version: number;
  updatedAt: number;
  sourceConversationId: string;
  sourceMessageIds: string[];
  sourceMessageVersions: Record<string, number>;
  correction?: string | null;
  correctionStatus?: "applied";
  supersedes?: PrivateMemorySupersededSource[];
};

export type PrivateMemoryPendingCorrection = PrivateMemorySource & {
  id: string;
  version: number;
  status: "needs_clarification";
  reason: "ambiguous_change" | "ambiguous_target" | "no_target";
  content?: string;
  candidateMemoryItemIds?: string[];
};

export type PrivateMemoryView = {
  enabled: boolean;
  revision: number;
  items: PrivateMemoryItem[];
  pendingCorrections?: PrivateMemoryPendingCorrection[];
  error?: string;
  status?: number;
};

function analyticsArea(path: string): "auth" | "events" | "partner" | "account" | "admin" {
  if (path.startsWith("/auth")) return "auth";
  if (path.startsWith("/partner")) return "partner";
  if (path.startsWith("/account")) return "account";
  if (path.startsWith("/admin")) return "admin";
  return "events";
}

async function apiFetch<T = Record<string, unknown>>(
  path: string,
  options?: { method?: string; body?: unknown }
): Promise<T> {
  const sessionRevision = getAccountSessionRevision();
  const changedSession = () => ({ error: "账号已变化，请重新打开页面。", status: 401 } as T);
  try {
    const sessionId = getAnalyticsSessionId();
    const res = await fetch(`/api${path}`, {
      method: options?.method ?? "GET",
      credentials: "include",
      signal: AbortSignal.timeout(20_000),
      headers: {
        "Content-Type": "application/json",
        ...(sessionId ? { "X-DeepWe-Session": sessionId } : {}),
      },
      body: options?.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
    if (sessionRevision !== getAccountSessionRevision()) return changedSession();
    if (res.ok && (res.status === 204 || res.status === 205)) return {} as T;
    let payload: unknown;
    try {
      payload = await res.json();
    } catch {
      return {
        error: res.ok ? "服务器返回了无法读取的响应，请稍后重试。" : "请求失败，请稍后重试。",
        status: res.status,
      } as T;
    }
    if (sessionRevision !== getAccountSessionRevision()) return changedSession();
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return { error: "服务器返回了无法读取的响应，请稍后重试。", status: res.status } as T;
    }
    const data = payload as Record<string, unknown>;
    if (!res.ok) {
      if (path !== "/auth/me" && path !== "/analytics/events" && path !== "/account/analytics-preference" && !path.startsWith("/conversations")) {
        trackAnalyticsBestEffort({
          name: "request_failed",
          result: res.status >= 500 ? "server_error" : "client_error",
          reason: analyticsArea(path),
        });
      }
      return {
        ...data,
        error: String(data.error ?? "请求失败，请稍后重试"),
        status: res.status,
      } as T;
    }
    if (["/auth/login", "/auth/register", "/auth/logout", "/auth/logout-all", "/auth/reset-password", "/account"].includes(path)
      && (options?.method ?? "GET") !== "GET") notifyAccountSessionChanged();
    return data as T;
  } catch (error) {
    if (sessionRevision !== getAccountSessionRevision()) return changedSession();
    if (path !== "/auth/me" && path !== "/analytics/events" && path !== "/account/analytics-preference" && !path.startsWith("/conversations")) {
      trackAnalyticsBestEffort({
        name: "request_failed",
        result: "network_error",
        reason: analyticsArea(path),
      });
    }
    const timedOut = error instanceof DOMException && error.name === "TimeoutError";
    return {
      error: timedOut
        ? "请求超时，操作结果可能尚未确定。请检查状态后重试。"
        : "网络连接失败，操作结果可能尚未确定。请检查网络后重试。",
      status: 0,
    } as T;
  }
}

// 私密聊天 API：请求失败统计不携带会话 ID、错误文本或消息内容。
export const getPrivateMemory = () =>
  apiFetch<PrivateMemoryView>("/private-memory");

export const updatePrivateMemorySettings = (enabled: boolean, expectedRevision: number) =>
  apiFetch<PrivateMemoryView>("/private-memory/settings", {
    method: "POST",
    body: { enabled, expectedRevision },
  });

export const updatePrivateMemoryItem = (
  id: string,
  content: string,
  expectedVersion: number,
  expectedRevision: number
) =>
  apiFetch<PrivateMemoryView>(`/private-memory/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: { content, expectedVersion, expectedRevision },
  });

export const forgetPrivateMemoryItem = (id: string, expectedVersion: number, expectedRevision: number) =>
  apiFetch<PrivateMemoryView>(`/private-memory/${encodeURIComponent(id)}`, {
    method: "DELETE",
    body: { expectedVersion, expectedRevision },
  });

export const clearPrivateMemory = (expectedRevision: number) =>
  apiFetch<PrivateMemoryView>("/private-memory", {
    method: "DELETE",
    body: { expectedRevision },
  });

export const getPrivateConversations = () =>
  apiFetch<{ conversations?: PrivateConversation[]; error?: string }>("/conversations");

export const createPrivateConversation = (title?: string, clientRequestId?: string) =>
  apiFetch<{ conversation?: PrivateConversation; error?: string; status?: number }>("/conversations", {
    method: "POST",
    body: {
      ...(title?.trim() ? { title: title.trim() } : {}),
      ...(clientRequestId ? { clientRequestId } : {}),
    },
  });

export const getPrivateConversation = (id: string) =>
  apiFetch<Partial<PrivateConversationDetail> & { error?: string; status?: number }>(
    `/conversations/${encodeURIComponent(id)}`
  );

export const deletePrivateConversation = (id: string) =>
  apiFetch<{ error?: string }>(`/conversations/${encodeURIComponent(id)}`, { method: "DELETE" });

export const sendPrivateMessage = (id: string, content: string, clientRequestId?: string) =>
  apiFetch<{ message?: PrivateMessage; jobId?: string; conversationVersion?: number; error?: string }>(
    `/conversations/${encodeURIComponent(id)}/messages`,
    { method: "POST", body: { content, ...(clientRequestId ? { clientRequestId } : {}) } }
  );

export const updatePrivateMessage = (
  conversationId: string,
  messageId: string,
  content: string,
  expectedVersion: number
) =>
  apiFetch<{ message?: PrivateMessage; jobId?: string; conversationVersion?: number; error?: string; status?: number }>(
    `/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}`,
    { method: "PATCH", body: { content, expectedVersion } }
  );

export const deletePrivateMessage = (
  conversationId: string,
  messageId: string,
  expectedVersion: number
) =>
  apiFetch<{ error?: string; status?: number }>(
    `/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}`,
    { method: "DELETE", body: { expectedVersion } }
  );

export const setPrivateReplyFeedback = (
  conversationId: string,
  messageId: string,
  rating: "up" | "down" | null,
  reason: ReplyFeedbackReason | null,
  expectedVersion: number
) =>
  apiFetch<{ feedback: PrivateReplyFeedback | null; responsePreferences: string[]; error?: string; status?: number }>(
    `/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}/feedback`,
    { method: "POST", body: { rating, reason, expectedVersion } }
  );

export const clearPrivateResponsePreferences = (conversationId: string, expectedVersion: number) =>
  apiFetch<{ feedback: null; responsePreferences: string[]; error?: string; status?: number }>(
    `/conversations/${encodeURIComponent(conversationId)}/response-preferences`,
    { method: "DELETE", body: { expectedVersion } }
  );

export const getPrivateJob = (conversationId: string, jobId: string) =>
  apiFetch<PrivateJobResult & { error?: string }>(
    `/conversations/${encodeURIComponent(conversationId)}/jobs/${encodeURIComponent(jobId)}`
  );

export const cancelPrivateJob = (conversationId: string, jobId: string) =>
  apiFetch<{ job?: PrivateJobResult["job"]; error?: string }>(
    `/conversations/${encodeURIComponent(conversationId)}/jobs/${encodeURIComponent(jobId)}/cancel`,
    { method: "POST", body: {} }
  );

export const retryPrivateJob = (conversationId: string, jobId: string) =>
  apiFetch<{ jobId?: string; error?: string }>(
    `/conversations/${encodeURIComponent(conversationId)}/jobs/${encodeURIComponent(jobId)}/retry`,
    { method: "POST", body: {} }
  );

export const refreshPrivateNotes = (conversationId: string) =>
  apiFetch<{ jobId?: string; notesVersion?: number; error?: string }>(
    `/conversations/${encodeURIComponent(conversationId)}/notes/refresh`,
    { method: "POST", body: {} }
  );

export const correctPrivateNote = (
  conversationId: string,
  noteId: string,
  correction: string,
  expectedVersion: number
) =>
  apiFetch<{ note?: PrivateNote; error?: string }>(
    `/conversations/${encodeURIComponent(conversationId)}/notes/${encodeURIComponent(noteId)}`,
    { method: "PATCH", body: { correction, expectedVersion } }
  );

export const createPrivateShareDraft = (conversationId: string, sourceMessageIds: string[]) =>
  apiFetch<{ draftId?: string; jobId?: string; error?: string }>(
    `/conversations/${encodeURIComponent(conversationId)}/share-drafts`,
    { method: "POST", body: { sourceMessageIds } }
  );

export const getPrivateShareDraft = (conversationId: string, draftId: string) =>
  apiFetch<{ draft?: PrivateShareDraft; error?: string }>(
    `/conversations/${encodeURIComponent(conversationId)}/share-drafts/${encodeURIComponent(draftId)}`
  );

export const updatePrivateShareDraft = (
  conversationId: string,
  draftId: string,
  content: string,
  expectedVersion: number
) =>
  apiFetch<{ draft?: PrivateShareDraft; error?: string }>(
    `/conversations/${encodeURIComponent(conversationId)}/share-drafts/${encodeURIComponent(draftId)}`,
    { method: "PATCH", body: { content, expectedVersion } }
  );

export const confirmPrivateShareDraft = (
  conversationId: string,
  draftId: string,
  version: number
) =>
  apiFetch<{ eventId?: string; shareVersion?: number; inviteStatus?: "pending"; error?: string; message?: string }>(
    `/conversations/${encodeURIComponent(conversationId)}/share-drafts/${encodeURIComponent(draftId)}/confirm`,
    { method: "POST", body: { version, invitePartner: true } }
  );

export interface ReviewInput {
  executed: string;
  effect: string;
  next: string;
}

export interface NvcSummaryInput {
  observation: string;
  feelings: string[];
  needs: string[];
  request: string;
}

// 账号
export const getRegistrationStatus = () =>
  apiFetch<{ inviteRequired: boolean; error?: string }>("/auth/registration-status");

export const registerAccount = (
  displayName: string,
  email: string,
  password: string,
  registrationCode: string
) =>
  apiFetch<{ user?: AccountUser; error?: string; status?: number }>("/auth/register", {
    method: "POST",
    body: { displayName, email, password, registrationCode },
  });

export const loginAccount = (email: string, password: string) =>
  apiFetch<{ user?: AccountUser; error?: string; status?: number }>("/auth/login", {
    method: "POST",
    body: { email, password },
  });

export const getCurrentAccount = () =>
  apiFetch<{ user: AccountUser | null; error?: string }>("/auth/me");

export const logoutAccount = () =>
  apiFetch<{ ok?: boolean; error?: string }>("/auth/logout", { method: "POST", body: {} });

export const changePassword = (currentPassword: string, newPassword: string) =>
  apiFetch<{ ok?: boolean; error?: string }>("/auth/change-password", {
    method: "POST",
    body: { currentPassword, newPassword },
  });

export const logoutAllDevices = () =>
  apiFetch<{ ok?: boolean; error?: string }>("/auth/logout-all", { method: "POST", body: {} });

export const resetPassword = (email: string, code: string, newPassword: string) =>
  apiFetch<{ ok?: boolean; error?: string }>("/auth/reset-password", {
    method: "POST",
    body: { email, code, newPassword },
  });

export const exportAccountData = () =>
  apiFetch<{ data?: Record<string, unknown>; error?: string }>("/account/export");

export const deleteAccount = (password: string) =>
  apiFetch<{ ok?: boolean; error?: string }>("/account", {
    method: "DELETE",
    body: { password },
  });

export const updateAnalyticsPreference = (enabled: boolean) =>
  apiFetch<{ analyticsEnabled?: boolean; analyticsNoticeSeen?: boolean; error?: string }>("/account/analytics-preference", {
    method: "PATCH",
    body: { enabled },
  });

export const markAnalyticsNoticeSeen = () =>
  apiFetch<{ analyticsNoticeSeen?: boolean; error?: string }>("/account/analytics-notice", {
    method: "POST",
    body: {},
  });

export const getPartnerOverview = () =>
  apiFetch<PartnerOverview & { error?: string }>("/partner");

export const createPartnerInvite = () =>
  apiFetch<{ invite?: PartnerInvite; error?: string }>("/partner/invites", {
    method: "POST",
    body: {},
  });

export const revokePartnerInvite = (id: string) =>
  apiFetch<{ ok?: boolean; error?: string }>(`/partner/invites/${id}`, {
    method: "DELETE",
  });

export const acceptPartnerInvite = (code: string) =>
  apiFetch<{ ok?: boolean; approvalPending?: boolean; error?: string }>("/partner/invites/accept", {
    method: "POST",
    body: { code },
  });

export const approvePartnerBinding = (id: string) =>
  apiFetch<{ ok?: boolean; error?: string }>(`/partner/invites/${id}/approve`, {
    method: "POST", body: {},
  });

export const cancelPartnerBinding = (id: string) =>
  apiFetch<{ ok?: boolean; error?: string }>(`/partner/requests/${id}`, { method: "DELETE" });

export const pausePartnerConnection = (days: 1 | 3 | 7) =>
  apiFetch<{ ok?: boolean; error?: string }>("/partner/connection/pause", {
    method: "POST", body: { days },
  });

export const resumePartnerConnection = () =>
  apiFetch<{ ok?: boolean; error?: string }>("/partner/connection/resume", {
    method: "POST", body: {},
  });

export const endPartnerConnection = () =>
  apiFetch<{ ok?: boolean; error?: string }>("/partner/connection", {
    method: "DELETE",
  });

export const cancelPartnerDisconnect = () =>
  apiFetch<{ ok?: boolean; error?: string }>("/partner/connection/cancel-disconnect", {
    method: "POST", body: {},
  });

export const requestPartnerRecovery = (id: string, restoreMemories: boolean) =>
  apiFetch<{ ok?: boolean; error?: string }>(`/partner/connections/${id}/recovery-request`, {
    method: "POST", body: { restoreMemories },
  });

export const approvePartnerRecovery = (id: string) =>
  apiFetch<{ ok?: boolean; error?: string }>(`/partner/connections/${id}/recovery-approve`, {
    method: "POST", body: {},
  });

export const getSharedSpace = () =>
  apiFetch<{ space?: SharedSpaceOverview; error?: string }>("/partner/space");

export const createSharedSpaceProposal = (
  category: SharedMemoryCategory,
  content: string
) =>
  apiFetch<{ space?: SharedSpaceOverview; error?: string }>("/partner/space/proposals", {
    method: "POST",
    body: { category, content },
  });

export const reviseSharedSpaceProposal = (id: string, content: string) =>
  apiFetch<{ space?: SharedSpaceOverview; error?: string }>(
    `/partner/space/proposals/${id}`,
    { method: "PATCH", body: { content } }
  );

type ConfirmSharedProposalResult = { space?: SharedSpaceOverview; error?: string };
export function confirmSharedSpaceProposal(id: string, expectedVersion: number): Promise<ConfirmSharedProposalResult> {
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
    return Promise.resolve({ error: "请先刷新并重新阅读当前共同记忆提案，再确认这一版。" });
  }
  return apiFetch<ConfirmSharedProposalResult>(
    `/partner/space/proposals/${id}/confirm`,
    { method: "POST", body: { expectedVersion } }
  );
}

export const rejectSharedSpaceProposal = (id: string, reason = "") =>
  apiFetch<{ space?: SharedSpaceOverview; error?: string }>(
    `/partner/space/proposals/${id}/reject`,
    { method: "POST", body: { reason } }
  );

export const acceptPartnerEventInvite = (id: string) =>
  apiFetch<{ id?: string; eventId?: string; conversationId?: string; error?: string }>(`/partner/event-invites/${id}/accept`, {
    method: "POST",
    body: {},
  });

export const snoozePartnerEventInvite = (id: string) =>
  apiFetch<{ ok?: boolean; error?: string }>(`/partner/event-invites/${id}/later`, {
    method: "POST",
    body: {},
  });

export const requestEventDeletion = (id: string) =>
  apiFetch<{ ok?: boolean; status?: "pending" | "deleted"; error?: string }>(
    `/events/${id}/deletion-request`, { method: "POST", body: {} }
  );

export const getMyEvents = () =>
  apiFetch<{ events?: AccountEventSummary[]; error?: string }>("/events");

export const getRegistrationInvites = () =>
  apiFetch<{ invites?: AdminRegistrationInvite[]; error?: string }>(
    "/admin/registration-invites"
  );

export const createRegistrationInvite = (note: string) =>
  apiFetch<{ invite?: AdminRegistrationInvite; error?: string }>(
    "/admin/registration-invites",
    { method: "POST", body: { note } }
  );

export const revokeRegistrationInvite = (id: string) =>
  apiFetch<{ ok?: boolean; error?: string }>(`/admin/registration-invites/${id}`, {
    method: "DELETE",
  });

export const getAdminUsers = () =>
  apiFetch<{ users?: AccountUser[]; error?: string }>("/admin/users");

export const getAdminAnalytics = (days: 7 | 30 | 90) =>
  apiFetch<{ analytics?: AdminAnalyticsDashboard; error?: string; status?: number }>(
    `/admin/analytics?days=${days}`
  );

export const createPasswordResetCode = (userId: string) =>
  apiFetch<{ reset?: { code: string; expiresAt: number }; error?: string }>(
    "/admin/password-resets",
    { method: "POST", body: { userId } }
  );

export const deleteEvent = (id: string) =>
  apiFetch<{ ok?: boolean; error?: string }>(`/events/${id}`, { method: "DELETE" });

export const renameEvent = (id: string, title: string) =>
  apiFetch<{ ok?: boolean; title?: string; error?: string }>(`/events/${id}/title`, {
    method: "PATCH",
    body: { title },
  });

// 写操作
export const createEvent = (title: string, rawText: string) =>
  apiFetch<{ id?: string; error?: string }>("/events", {
    method: "POST",
    body: { title, rawText },
  });

export const joinEvent = (code: string) =>
  apiFetch<{ id?: string; error?: string }>("/events/join", {
    method: "POST",
    body: { code },
  });

export const sendGuideMessage = (id: string, message: string) =>
  apiFetch<{ error?: string }>(`/events/${id}/guide`, {
    method: "POST",
    body: { message },
  });

export const editGuideMessage = (id: string, messageId: number, message: string) =>
  apiFetch<{ error?: string }>(`/events/${id}/guide/messages/${messageId}`, {
    method: "PATCH",
    body: { message },
  });

export const deleteGuideMessage = (id: string, messageId: number) =>
  apiFetch<{ ok?: boolean; error?: string }>(`/events/${id}/guide/messages/${messageId}`, {
    method: "DELETE",
  });

export const regenerateGuideReply = (id: string, messageId: number, reason: string) =>
  apiFetch<{ error?: string }>(`/events/${id}/guide/messages/${messageId}/regenerate`, {
    method: "POST",
    body: { reason },
  });

export const stopAiReply = (id: string) =>
  apiFetch<{ ok?: boolean; error?: string }>(`/events/${id}/ai/stop`, {
    method: "POST",
    body: {},
  });

export const finishGuiding = (id: string) =>
  apiFetch<{ error?: string }>(`/events/${id}/guide/finish`, { method: "POST", body: {} });

export const endGuiding = (id: string) =>
  apiFetch<{ state?: string; error?: string }>(`/events/${id}/guide/end`, {
    method: "POST",
    body: {},
  });

export const continueFromSummary = (id: string) =>
  apiFetch<{ state?: string; error?: string }>(`/events/${id}/summary/continue`, {
    method: "POST",
    body: {},
  });

export const retryAiJob = (id: string, expectedJobId: string, expectedAttempt: number) =>
  apiFetch<{ queued?: boolean; error?: string; code?: string; retryAllowed?: boolean }>(`/events/${id}/ai/retry`, {
    method: "POST",
    body: { expectedJobId, expectedAttempt },
  });

export const confirmASummary = (id: string, edited?: NvcSummaryInput) =>
  apiFetch<{ code?: string; partnerTargeted?: boolean; error?: string }>(`/events/${id}/summary/confirm`, {
    method: "POST",
    body: { edited },
  });

export const confirmBSummary = (id: string, edited?: NvcSummaryInput) =>
  apiFetch<{ error?: string }>(`/events/${id}/b-summary/confirm`, {
    method: "POST",
    body: { edited },
  });

type ConfirmMergedResult = { bothConfirmed: boolean; regenerated: boolean; error?: string };
export function confirmMerged(id: string, expectedVersion: number, correction?: string): Promise<ConfirmMergedResult>;
/** Keeps archived source snapshots type-checkable; this signature fails closed at runtime. */
export function confirmMerged(id: string, legacyCorrection?: string): Promise<ConfirmMergedResult>;
export function confirmMerged(id: string, versionOrCorrection?: number | string, correction?: string): Promise<ConfirmMergedResult> {
  if (typeof versionOrCorrection !== "number") {
    return Promise.resolve({ bothConfirmed: false, regenerated: false, error: "请先刷新并确认当前共同理解版本。" });
  }
  return apiFetch<ConfirmMergedResult>(`/events/${id}/merged/confirm`, {
    method: "POST",
    body: { expectedVersion: versionOrCorrection, ...(correction ? { correction } : {}) },
  });
}

export const chooseAgreement = (id: string, choice: string) =>
  apiFetch<{ done: boolean; error?: string }>(`/events/${id}/agreement`, {
    method: "POST",
    body: { choice },
  });

export const submitReview = (id: string, review: ReviewInput) =>
  apiFetch<{ bothReviewed: boolean; error?: string }>(`/events/${id}/review`, {
    method: "POST",
    body: review,
  });

export const declineEvent = (id: string) =>
  apiFetch<{ ok: boolean; error?: string }>(`/events/${id}/decline`, { method: "POST", body: {} });

export const withdrawInvite = (id: string) =>
  apiFetch<{ ok: boolean; error?: string }>(`/events/${id}/withdraw`, { method: "POST", body: {} });

export const continueAfterWithdraw = (id: string) =>
  apiFetch<{ state?: string; error?: string }>(`/events/${id}/withdraw/continue`, {
    method: "POST",
    body: {},
  });

export const resubmitAfterWithdraw = (id: string) =>
  apiFetch<{ state?: string; code?: string; partnerTargeted?: boolean; error?: string }>(
    `/events/${id}/withdraw/resubmit`,
    { method: "POST", body: {} }
  );

export const refreshExpiredEventInvite = (id: string) =>
  apiFetch<{ state?: string; code?: string; error?: string }>(
    `/events/${id}/invite/refresh`,
    { method: "POST", body: {} }
  );

// 读操作
export const getEvent = (id: string) =>
  apiFetch<EventData & { error?: string; status?: number }>(`/events/${id}`);
