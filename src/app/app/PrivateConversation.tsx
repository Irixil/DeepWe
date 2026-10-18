"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import {
  cancelPrivateJob,
  clearPrivateResponsePreferences,
  confirmPrivateShareDraft,
  correctPrivateNote,
  createPrivateShareDraft,
  declineEvent,
  deletePrivateMessage,
  getCurrentAccount,
  getEvent,
  getPrivateConversation,
  getPrivateJob,
  getPrivateShareDraft,
  refreshPrivateNotes,
  retryPrivateJob,
  sendPrivateMessage,
  setPrivateReplyFeedback,
  updateAnalyticsPreference,
  updatePrivateMessage,
  updatePrivateShareDraft,
} from "@/lib/api";
import type { AccountUser, EventData, PrivateConversationDetail, PrivateJob, PrivateMessage, PrivateNote, PrivateShareDraft, ReplyFeedbackReason } from "@/lib/types";
import styles from "./private.module.css";
import { AuthCard } from "./PrivateConversationHome";
import { ReplyText } from "./ReplyText";
import { trackAnalytics, trackAnalyticsBestEffort } from "@/lib/analytics";
import PrivateAccountBoundary from "./PrivateAccountBoundary";

const B_EXITABLE_EVENT_STATES = new Set(["b_guiding", "b_expressing", "b_summary"]);
type ReloadedConversation = PrivateConversationDetail & { jobs: PrivateJob[]; jobsSnapshotComplete: boolean };
const REPLY_FEEDBACK_REASONS: Record<"up" | "down", { value: ReplyFeedbackReason; label: string }[]> = {
  up: [
    { value: "natural", label: "自然亲切" },
    { value: "clear", label: "清楚有帮助" },
    { value: "helpful_advice", label: "建议有用" },
  ],
  down: [
    { value: "mechanical", label: "太机械" },
    { value: "too_many_questions", label: "问得太多" },
    { value: "too_much_advice", label: "建议太多" },
    { value: "too_distant", label: "像在劝我停下" },
    { value: "misunderstood", label: "没理解我的意思" },
  ],
};
const RESPONSE_PREFERENCE_LABELS: Partial<Record<ReplyFeedbackReason, string>> = Object.fromEntries(
  Object.values(REPLY_FEEDBACK_REASONS).flat().map(({ value, label }) => [value, label])
);
type MessageIconName = "copy" | "edit" | "delete" | "up" | "down";

function MessageIcon({ name }: { name: MessageIconName }) {
  const common = { fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  return <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false" {...common}>
    {name === "copy" && <><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></>}
    {name === "edit" && <><path d="m4 16.5-.8 4.3 4.3-.8L20 7.5 16.5 4 4 16.5Z" /><path d="m14.8 5.7 3.5 3.5" /></>}
    {name === "delete" && <><path d="M4 7h16" /><path d="M10 11v6M14 11v6" /><path d="m5 7 1 13h12l1-13M9 7V4h6v3" /></>}
    {name === "up" && <path d="M7 10v11H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3Zm0 0 4-7a3 3 0 0 1 3 3v4h5a2 2 0 0 1 2 2l-2 7a2 2 0 0 1-2 2H7" />}
    {name === "down" && <path d="M7 10v11H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3Zm0 0 4-7a3 3 0 0 1 3 3v4h5a2 2 0 0 1 2 2l-2 7a2 2 0 0 1-2 2H7" transform="rotate(180 12 12)" />}
  </svg>;
}

export default function PrivateConversation({ conversationId }: { conversationId: string }) {
  return <PrivateAccountBoundary><PrivateConversationScreen conversationId={conversationId} /></PrivateAccountBoundary>;
}

function PrivateConversationScreen({ conversationId }: { conversationId: string }) {
  const router = useRouter();
  const [account, setAccount] = useState<AccountUser | null | undefined>();
  const [detail, setDetail] = useState<PrivateConversationDetail | null>(null);
  const [linkedEvent, setLinkedEvent] = useState<{ eventId: string; data: EventData } | null>(null);
  const [linkedEventSync, setLinkedEventSync] = useState<{ eventId: string; status: "loading" | "error" } | null>(null);
  const [linkedEventRefreshKey, setLinkedEventRefreshKey] = useState(0);
  const lastEventFocusRefresh = useRef(0);
  const [leavingLinkedEvent, setLeavingLinkedEvent] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [conversationRefreshFailed, setConversationRefreshFailed] = useState(false);
  const [composer, setComposer] = useState("");
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [jobs, setJobs] = useState<PrivateJob[]>([]);
  const [editingMessage, setEditingMessage] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [sharing, setSharing] = useState(false);
  const [draftId, setDraftId] = useState<string | null>(null);
  const [draft, setDraft] = useState<PrivateShareDraft | null>(null);
  const [draftText, setDraftText] = useState("");
  const [shareConfirmation, setShareConfirmation] = useState<{
    draftId: string;
    version: number;
    editRevision: number;
    linkedSide: "a" | "b" | null;
    linkedEventId: string | null;
  } | null>(null);
  const [noteText, setNoteText] = useState<Record<string, string>>({});
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [feedbackChoices, setFeedbackChoices] = useState<{ rating: "up" | "down"; messageId: string } | null>(null);
  const [feedbackBusy, setFeedbackBusy] = useState(false);
  const [copyNotice, setCopyNotice] = useState("");
  const [endPromptOpen, setEndPromptOpen] = useState(false);
  const [endResult, setEndResult] = useState<"lighter" | "same" | "worse" | "unclear" | "">("");
  const [endReason, setEndReason] = useState("");
  const [privacyBusy, setPrivacyBusy] = useState(false);
  const [privacyError, setPrivacyError] = useState("");
  const [jobStatusErrors, setJobStatusErrors] = useState<Record<string, string>>({});
  const [jobPollRefreshKey, setJobPollRefreshKey] = useState(0);
  const [savingDraft, setSavingDraft] = useState(false);
  const [savingNoteId, setSavingNoteId] = useState<string | null>(null);
  const [confirmingShare, setConfirmingShare] = useState(false);
  const sendLockRef = useRef(false);
  const pendingSendIdsRef = useRef(new Map<string, string>());
  const reloadRequestRef = useRef(0);
  const jobsRef = useRef(jobs);
  const jobPollLockRef = useRef(false);
  const jobDraftIdsRef = useRef(new Map<string, string>());
  const activeDraftIdRef = useRef<string | null>(null);
  const draftLoadRequestRef = useRef(0);
  const draftEditRevisionRef = useRef(0);
  const draftSaveLockRef = useRef(false);
  const noteSaveLockRef = useRef(false);
  const shareConfirmLockRef = useRef(false);
  const feedbackLockRef = useRef(false);
  const latestUserMessageId = detail?.latestTurn.userMessageId ?? null;
  const latestAssistantMessageId = detail?.latestTurn.assistantMessageId ?? null;
  const feedbackChoicesFor = feedbackChoices?.messageId === latestAssistantMessageId ? feedbackChoices.rating : null;
  const staleEditDraft = editingMessage && editingMessage !== latestUserMessageId ? editText : "";
  const liveJobs = jobs.filter((item) => ["queued", "processing"].includes(item.status));
  const liveReplyJob = liveJobs.find((item) => item.kind === "reply");
  const mutationLocked = busy || feedbackBusy || Boolean(liveReplyJob);
  const currentLinkedEvent = linkedEvent && linkedEvent.eventId === detail?.conversation.linkedEventId ? linkedEvent.data : null;
  const currentLinkedEventSync = linkedEventSync?.eventId === detail?.conversation.linkedEventId ? linkedEventSync : null;
  const reload = useCallback(async (options: { updateJobs?: boolean } = {}): Promise<ReloadedConversation | null | undefined> => {
    const requestId = ++reloadRequestRef.current;
    const result = await getPrivateConversation(conversationId);
    if (requestId !== reloadRequestRef.current) return undefined;
    if (result.error || !result.conversation) {
      if (result.status === 401 || result.status === 404) {
        setDetail(null); setJobs([]); setDraft(null); setDraftId(null); setDraftText("");
        setShareConfirmation(null);
        setComposer(""); setEditingMessage(null); setEditText(""); setSelectedIds([]);
        setNoteText({}); setEditingNoteId(null); setLinkedEvent(null); setLinkedEventSync(null);
        setFeedbackChoices(null); setEndPromptOpen(false); setEndResult(""); setEndReason("");
        jobsRef.current = []; jobDraftIdsRef.current.clear(); pendingSendIdsRef.current.clear();
        activeDraftIdRef.current = null; draftLoadRequestRef.current += 1;
        if (result.status === 401) setAccount(null);
      }
      setError(result.status === 404 ? "没有找到这段私密对话，或你无权查看。" : result.error ?? "暂时无法读取对话。请稍后重试。");
      return null;
    }
    const next: PrivateConversationDetail = {
      conversation: result.conversation,
      messages: result.messages ?? [],
      notes: result.notes ?? [],
      pendingJob: result.pendingJob ?? null,
      shareDrafts: result.shareDrafts ?? [],
      jobs: result.jobs ?? (result.pendingJob ? [result.pendingJob] : []),
      latestTurn: result.latestTurn ?? { userMessageId: null, assistantMessageId: null },
      replyFeedback: result.replyFeedback ?? null,
      responsePreferences: result.responsePreferences ?? [],
    };
    setDetail(next);
    if (options.updateJobs !== false) {
      if (result.jobs) setJobs(result.jobs);
      else if (result.pendingJob) setJobs((items) => [...items.filter((item) => item.kind !== result.pendingJob!.kind), result.pendingJob!]);
    }
    setError("");
    setConversationRefreshFailed(false);
    return { ...next, jobs: next.jobs ?? [], jobsSnapshotComplete: Array.isArray(result.jobs) };
  }, [conversationId]);

  useEffect(() => {
    jobsRef.current = jobs;
  }, [jobs]);

  useEffect(() => {
    return () => { reloadRequestRef.current += 1; draftLoadRequestRef.current += 1; };
  }, []);

  useEffect(() => {
    let active = true;
    Promise.all([getCurrentAccount(), getPrivateConversation(conversationId)]).then(([userResult, result]) => {
      if (!active) return;
      setAccount(userResult.error ? null : userResult.user);
      if (!userResult.error && userResult.user?.analyticsNoticeSeen && userResult.user.analyticsEnabled) trackAnalyticsBestEffort({ name: "app_opened", screen: "conversation", step: "conversation" });
      if (result.error || !result.conversation) {
        setError(result.status === 404 ? "没有找到这段私密对话，或你无权查看。" : result.error ?? "暂时无法读取对话。");
      } else {
        setDetail({
          conversation: result.conversation,
          messages: result.messages ?? [],
          notes: result.notes ?? [],
          pendingJob: result.pendingJob ?? null,
          shareDrafts: result.shareDrafts ?? [],
          jobs: result.jobs,
          latestTurn: result.latestTurn ?? { userMessageId: null, assistantMessageId: null },
          replyFeedback: result.replyFeedback ?? null,
          responsePreferences: result.responsePreferences ?? [],
        });
        setJobs(result.jobs ?? (result.pendingJob ? [result.pendingJob] : []));
      }
      setLoading(false);
    });
    return () => { active = false; };
  }, [conversationId]);

  useEffect(() => {
    const eventId = detail?.conversation.linkedEventId;
    if (!eventId || detail?.conversation.linkedSide !== "b") return;
    let active = true;
    void Promise.resolve().then(async () => {
      if (!active) return;
      setLinkedEventSync({ eventId, status: "loading" });
      try {
        const event = await getEvent(eventId);
        if (!active) return;
        if (event.error) {
          setLinkedEvent(null);
          setLinkedEventSync({ eventId, status: "error" });
        } else {
          setLinkedEvent({ eventId, data: event });
          setLinkedEventSync(null);
        }
      } catch {
        if (!active) return;
        setLinkedEvent(null);
        setLinkedEventSync({ eventId, status: "error" });
      }
    });
    return () => { active = false; };
  }, [detail?.conversation.linkedEventId, detail?.conversation.linkedSide, linkedEventRefreshKey]);

  useEffect(() => {
    lastEventFocusRefresh.current = Date.now();
    const refreshOnReturn = () => {
      if (document.visibilityState !== "visible" || Date.now() - lastEventFocusRefresh.current < 1000) return;
      lastEventFocusRefresh.current = Date.now();
      setLinkedEventRefreshKey((key) => key + 1);
    };
    window.addEventListener("focus", refreshOnReturn);
    document.addEventListener("visibilitychange", refreshOnReturn);
    return () => {
      window.removeEventListener("focus", refreshOnReturn);
      document.removeEventListener("visibilitychange", refreshOnReturn);
    };
  }, []);

  useEffect(() => {
    if (!account?.analyticsNoticeSeen || !account.analyticsEnabled) return;
    const startedAt = Date.now();
    trackAnalyticsBestEffort({ name: "screen_viewed", eventId: conversationId, screen: "conversation", step: "conversation" });
    return () => trackAnalyticsBestEffort({ name: "screen_left", eventId: conversationId, screen: "conversation", step: "conversation", durationMs: Date.now() - startedAt });
  }, [account?.id, account?.analyticsNoticeSeen, account?.analyticsEnabled, conversationId]);

  useEffect(() => {
    if (!latestAssistantMessageId) return;
    const distanceToBottom = document.documentElement.scrollHeight - window.innerHeight - window.scrollY;
    if (distanceToBottom < 700) document.getElementById(`message-${latestAssistantMessageId}`)?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [conversationId, latestAssistantMessageId]);

  const activeJobKey = jobs.filter((item) => ["queued", "processing"].includes(item.status)).map((item) => `${item.id}:${item.kind}`).sort().join("|");
  useEffect(() => {
    if (!activeJobKey) return;
    let active = true;
    const poll = async () => {
      if (jobPollLockRef.current) return;
      jobPollLockRef.current = true;
      try {
        const activeJobs = jobsRef.current.filter((item) => ["queued", "processing"].includes(item.status));
        await Promise.all(activeJobs.map(async (currentJob) => {
          const result = await getPrivateJob(conversationId, currentJob.id);
          if (!active || !result.job) {
            if (active && result.error) setJobStatusErrors((items) => ({ ...items, [currentJob.id]: result.error! }));
            return;
          }
          setJobStatusErrors((items) => {
            if (!items[currentJob.id]) return items;
            const next = { ...items };
            delete next[currentJob.id];
            return next;
          });
          const nextJob = result.job;
          if (!["completed", "failed", "cancelled"].includes(nextJob.status)) {
            setJobs((items) => items.map((item) => item.id === nextJob.id ? nextJob : item));
            return;
          }

          const refreshed = await reload({ updateJobs: false });
          if (!active) return;
          const targetDraftId = nextJob.kind === "share_draft" ? jobDraftIdsRef.current.get(nextJob.id) : undefined;
          if (nextJob.kind === "share_draft" && nextJob.status === "completed" && targetDraftId && activeDraftIdRef.current === targetDraftId) {
            const revisionBeforeLoad = draftEditRevisionRef.current;
            const loaded = await getPrivateShareDraft(conversationId, targetDraftId);
            if (active && loaded.draft && activeDraftIdRef.current === targetDraftId && draftEditRevisionRef.current === revisionBeforeLoad) {
              setShareConfirmation(null);
              setDraftId(targetDraftId);
              setDraft(loaded.draft);
              setDraftText(loaded.draft.content);
              setSharing(true);
            }
          }
          if (!active) return;
          setJobs((items) => {
            const snapshot = refreshed?.jobsSnapshotComplete
              ? refreshed.jobs
              : [...items.filter((item) => ["queued", "processing"].includes(item.status)), ...(refreshed?.jobs ?? [])];
            const uniqueJobs = [...new Map(snapshot.map((item) => [item.id, item])).values()];
            return [...uniqueJobs.filter((item) => item.id !== nextJob.id && (item.kind !== nextJob.kind || ["queued", "processing"].includes(item.status))), nextJob];
          });
          if (refreshed === null && nextJob.status === "completed") {
            setConversationRefreshFailed(true);
            setError("后台任务已完成，但对话暂时无法刷新。");
          }
        }));
      } finally {
        jobPollLockRef.current = false;
      }
    };
    const timer = window.setInterval(() => void poll(), 1400);
    void poll();
    return () => { active = false; window.clearInterval(timer); };
  }, [activeJobKey, conversationId, jobPollRefreshKey, reload]);

  async function startJob(result: { jobId?: string; error?: string }, kind: PrivateJob["kind"], targetDraftId?: string) {
    if (!result.jobId) { setError(result.error ?? "请求没有排入后台，请稍后重试。你写的内容仍然保留。"); return; }
    if (targetDraftId) {
      jobDraftIdsRef.current.set(result.jobId, targetDraftId);
      activeDraftIdRef.current = targetDraftId;
    }
    const pending: PrivateJob = { id: result.jobId, kind, status: "queued", inputVersion: detail?.conversation.version ?? 0, createdAt: 0, updatedAt: 0 };
    setJobs((items) => [...items.filter((item) => item.kind !== kind), pending]);
    setError("");
  }

  async function submitMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const content = composer.trim();
    if (!content || busy || sendLockRef.current) return;
    sendLockRef.current = true;
    const requestId = pendingSendIdsRef.current.get(content) ?? crypto.randomUUID();
    pendingSendIdsRef.current.set(content, requestId);
    setBusy(true);
    try {
      const result = await sendPrivateMessage(conversationId, content, requestId);
      if (result.message) {
        pendingSendIdsRef.current.delete(content);
        setDetail((current) => current ? {
          ...current,
          conversation: { ...current.conversation, version: Math.max(current.conversation.version, result.conversationVersion ?? current.conversation.version) },
          messages: current.messages.some((message) => message.id === result.message!.id) ? current.messages : [...current.messages, result.message!],
          latestTurn: { userMessageId: result.message!.id, assistantMessageId: null },
          replyFeedback: null,
        } : current);
        setComposer((current) => current.trim() === content ? "" : current);
        if (account?.analyticsNoticeSeen && account.analyticsEnabled) trackAnalyticsBestEffort({ name: "conversation_message_sent", eventId: conversationId, screen: "conversation", step: "conversation" });
      }
      if (result.jobId) await startJob(result, "reply");
      else setError(result.error ?? (result.message ? "消息已保存，但回复没有排入。你可以稍后重试回复。" : "消息发送结果不确定。保留文字后重试会沿用同一请求编号。"));
    } finally {
      setBusy(false);
      sendLockRef.current = false;
    }
  }

  async function saveMessageEdit(message: PrivateMessage) {
    if (message.id !== latestUserMessageId || mutationLocked) return;
    setBusy(true);
    const result = await updatePrivateMessage(conversationId, message.id, editText.trim(), detail?.conversation.version ?? message.version);
    setBusy(false);
    if (result.error) {
      if (result.status === 409) {
        await reload();
        setError("对话已更新，已重新读取最新内容。你的修改草稿仍保留；请检查后再保存。");
      } else setError(result.error);
      return;
    }
    if (result.message) {
      setDetail((current) => {
        if (!current) return current;
        const editedIndex = current.messages.findIndex((item) => item.id === result.message!.id);
        return {
          ...current,
          conversation: { ...current.conversation, version: Math.max(current.conversation.version, result.conversationVersion ?? current.conversation.version) },
          messages: current.messages.map((item, index) => item.id === result.message!.id
            ? result.message!
            : index > editedIndex && item.role === "assistant" && item.status === "current"
              ? { ...item, status: "superseded" }
              : item),
        };
      });
    }
    setEditingMessage(null);
    const refreshed = await reload();
    await startJob(result, "reply");
    if (refreshed === null) setError("修改已提交，但最新对话暂时无法读取。请刷新后确认内容；回复任务仍会继续。");
  }

  async function removeMessage(message: PrivateMessage) {
    if (message.id !== latestUserMessageId || mutationLocked) return;
    if (!window.confirm("删除这条消息后，依赖它的后续回复和理解也可能失效。继续删除？")) return;
    const result = await deletePrivateMessage(conversationId, message.id, detail?.conversation.version ?? message.version);
    if (result.error) {
      if (result.status === 409) {
        await reload();
        setError("对话已更新，已重新读取最新内容。你当前输入仍保留。");
      } else setError(result.error);
      return;
    }
    await reload();
  }

  async function copyMessage(message: PrivateMessage) {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopyNotice("已复制到剪贴板。");
    } catch {
      setError("复制失败，请检查浏览器剪贴板权限后重试。");
    }
  }

  async function saveReplyFeedback(rating: "up" | "down" | null, reason: ReplyFeedbackReason | null) {
    const messageId = detail?.latestTurn.assistantMessageId;
    if (!messageId || !detail || feedbackLockRef.current || mutationLocked) return;
    feedbackLockRef.current = true;
    setFeedbackBusy(true);
    setError("");
    try {
      const result = await setPrivateReplyFeedback(conversationId, messageId, rating, reason, detail.conversation.version);
      if (result.error) {
        if (result.status === 409) {
          setFeedbackChoices(null);
          await reload();
          setError("对话已更新，已读取最新状态。请对最新一条回应重新反馈。");
        } else setError(result.error);
        return;
      }
      setFeedbackChoices(rating && messageId ? { rating, messageId } : null);
      await reload();
    } finally {
      feedbackLockRef.current = false;
      setFeedbackBusy(false);
    }
  }

  async function clearResponsePreferences() {
    if (!detail || feedbackLockRef.current || mutationLocked) return;
    feedbackLockRef.current = true;
    setFeedbackBusy(true);
    setError("");
    try {
      const result = await clearPrivateResponsePreferences(conversationId, detail.conversation.version);
      if (result.error) {
        if (result.status === 409) {
          setFeedbackChoices(null);
          await reload();
          setError("对话已更新，已读取最新状态。请确认后再清除回应偏好。");
        } else setError(result.error);
        return;
      }
      setFeedbackChoices(null);
      await reload();
      setError("已清除这段对话的回应偏好。");
    } finally {
      feedbackLockRef.current = false;
      setFeedbackBusy(false);
    }
  }

  async function stopJob(currentJob: PrivateJob) {
    const result = await cancelPrivateJob(conversationId, currentJob.id);
    if (result.error) { setError(result.error); return; }
    if (result.job) setJobs((items) => [...items.filter((item) => item.kind !== currentJob.kind), result.job!]);
    if (account?.analyticsNoticeSeen && account.analyticsEnabled) trackAnalyticsBestEffort({ name: "ai_stopped", eventId: conversationId, screen: "conversation", step: "conversation" });
    await reload();
  }

  async function retryJob(currentJob: PrivateJob) {
    const result = await retryPrivateJob(conversationId, currentJob.id);
    if (result.jobId && account?.analyticsNoticeSeen && account.analyticsEnabled) trackAnalyticsBestEffort({ name: "ai_retried", eventId: conversationId, screen: "conversation", step: "conversation" });
    await startJob(result, currentJob.kind, jobDraftIdsRef.current.get(currentJob.id));
  }

  async function refreshNotes() {
    setBusy(true);
    const result = await refreshPrivateNotes(conversationId);
    setBusy(false);
    await startJob(result, "notes");
  }

  async function saveNote(note: PrivateNote) {
    if (noteSaveLockRef.current) return;
    noteSaveLockRef.current = true;
    setSavingNoteId(note.id);
    const correction = noteText[note.id] ?? note.correction ?? note.content;
    try {
      const result = await correctPrivateNote(conversationId, note.id, correction, note.version);
      if (result.error) { setError(result.error); return; }
      if ((noteText[note.id] ?? note.correction ?? note.content) === correction) setEditingNoteId(null);
      await reload();
    } finally {
      noteSaveLockRef.current = false;
      setSavingNoteId(null);
    }
  }

  async function prepareShare() {
    if (!selectedIds.length) { setError("先选择你愿意整理的本人消息。AI 回复和私密笔记不会进入草稿。"); return; }
    setShareConfirmation(null);
    setBusy(true);
    const result = await createPrivateShareDraft(conversationId, selectedIds);
    setBusy(false);
    if (result.error || !result.jobId || !result.draftId) { setError(result.error ?? "暂时无法整理分享草稿。"); return; }
    if (account?.analyticsNoticeSeen && account.analyticsEnabled) trackAnalyticsBestEffort({ name: "conversation_share_prepared", eventId: conversationId, screen: "conversation", step: "conversation" });
    setDraftId(result.draftId);
    draftLoadRequestRef.current += 1;
    activeDraftIdRef.current = result.draftId;
    setDraft(null);
    setDraftText("");
    draftEditRevisionRef.current += 1;
    setSharing(true);
    await startJob(result, "share_draft", result.draftId);
    setError("草稿只对你可见。生成后请逐字核对并修改，再由你确认分享。");
  }

  async function saveDraft() {
    if (!draft || draftSaveLockRef.current) return;
    setShareConfirmation(null);
    const submittedDraftId = draft.id;
    draftSaveLockRef.current = true;
    setSavingDraft(true);
    const submittedText = draftText;
    const revision = draftEditRevisionRef.current;
    try {
      const result = await updatePrivateShareDraft(conversationId, draft.id, submittedText, draft.version);
      if (activeDraftIdRef.current !== submittedDraftId) return;
      if (result.error || !result.draft) { setError(result.error ?? "草稿没有保存，请稍后重试。"); return; }
      setDraft(result.draft);
      if (draftEditRevisionRef.current === revision) setDraftText(result.draft.content);
      const refreshed = await reload();
      if (activeDraftIdRef.current === submittedDraftId) {
        if (refreshed) setError("当前草稿版本已保存。分享前仍需你单独确认。");
        else if (refreshed === null) setError("草稿已保存，但列表暂时无法刷新。分享前仍需你单独确认。");
      }
    } finally {
      draftSaveLockRef.current = false;
      setSavingDraft(false);
    }
  }

  async function openDraft(id: string) {
    setShareConfirmation(null);
    const requestId = ++draftLoadRequestRef.current;
    activeDraftIdRef.current = id;
    draftEditRevisionRef.current += 1;
    setBusy(true);
    const result = await getPrivateShareDraft(conversationId, id);
    if (requestId !== draftLoadRequestRef.current) return;
    setBusy(false);
    if (!result.draft) { setError(result.error ?? "暂时无法打开这份草稿。它仍保持私密。"); return; }
    setDraftId(id);
    setDraft(result.draft);
    setDraftText(result.draft.content);
    setSharing(true);
    setError("");
  }

  function startShareConfirmation() {
    if (!draft || draft.status !== "draft" || draftText !== draft.content || activeDraftIdRef.current !== draft.id || draftSaveLockRef.current || shareConfirmLockRef.current) {
      setShareConfirmation(null);
      setError("草稿或版本已变化，请重新读取当前版本后再确认。");
      return;
    }
    const isLinkedB = detail?.conversation.linkedSide === "b";
    const linkedEventId = detail?.conversation.linkedEventId;
    setShareConfirmation({
      draftId: draft.id,
      version: draft.version,
      editRevision: draftEditRevisionRef.current,
      linkedSide: isLinkedB ? "b" : "a",
      linkedEventId: linkedEventId ?? null,
    });
  }

  async function confirmShare() {
    if (!draft || !shareConfirmation || shareConfirmLockRef.current) return;
    const isLinkedB = detail?.conversation.linkedSide === "b";
    const linkedEventId = detail?.conversation.linkedEventId;
    const confirmationMatches = shareConfirmation.draftId === draft.id
      && shareConfirmation.version === draft.version
      && shareConfirmation.editRevision === draftEditRevisionRef.current
      && shareConfirmation.linkedSide === (isLinkedB ? "b" : "a")
      && shareConfirmation.linkedEventId === (linkedEventId ?? null)
      && activeDraftIdRef.current === draft.id
      && draft.status === "draft"
      && draftText === draft.content
      && !draftSaveLockRef.current;
    if (!confirmationMatches) {
      setShareConfirmation(null);
      setError("草稿或版本已变化，请重新读取当前版本后再确认。");
      return;
    }
    shareConfirmLockRef.current = true;
    setShareConfirmation(null);
    setConfirmingShare(true);
    try {
      const result = await confirmPrivateShareDraft(conversationId, draft.id, draft.version);
      if (result.error) { setError(result.message ?? (result.error === "PARTNER_BINDING_REQUIRED" ? "请先在双人空间建立双方确认的伴侣绑定；草稿仍保持私密。" : result.error)); return; }
      if (account?.analyticsNoticeSeen && account.analyticsEnabled) trackAnalyticsBestEffort({ name: "conversation_share_confirmed", eventId: conversationId, screen: "conversation", step: "conversation" });
      setSharing(false);
      const refreshed = await reload();
      if (!refreshed) return;
      setError(isLinkedB ? "你确认的摘要已进入这场复盘。" : "已邀请已绑定的伴侣。分享范围固定在你确认的这一版。");
      if (isLinkedB && linkedEventId) router.push(`/e/${encodeURIComponent(result.eventId ?? linkedEventId)}`);
    } finally {
      shareConfirmLockRef.current = false;
      setConfirmingShare(false);
    }
  }

  function toggleReplyFeedbackChoices(rating: "up" | "down") {
    const current = detail?.replyFeedback;
    const revoking = current?.rating === rating;
    setFeedbackChoices(revoking || !latestAssistantMessageId ? null : { rating, messageId: latestAssistantMessageId });
    void saveReplyFeedback(revoking ? null : rating, null);
  }

  function beginEnding() {
    if (account?.analyticsNoticeSeen && account.analyticsEnabled) trackAnalyticsBestEffort({ name: "guide_ended", eventId: conversationId, screen: "conversation", step: "conversation" });
    if (account?.analyticsNoticeSeen) setEndPromptOpen(true);
    else router.push("/app");
  }

  async function submitEndFeedback(result: "lighter" | "same" | "worse" | "unclear" | "skipped") {
    if (account?.analyticsNoticeSeen && account.analyticsEnabled) await trackAnalytics({ name: "core_outcome_submitted", eventId: conversationId, screen: "conversation", step: "conversation", result, ...((result === "same" || result === "worse") && endReason ? { reason: endReason } : {}) });
    router.push("/app");
  }

  async function saveAnalyticsPreference(enabled: boolean) {
    setPrivacyBusy(true);
    setPrivacyError("");
    const result = await updateAnalyticsPreference(enabled);
    setPrivacyBusy(false);
    if (result.error || result.analyticsEnabled === undefined) { setPrivacyError(result.error ?? "暂时无法保存设置，请稍后重试。"); return; }
    setAccount((current) => current ? { ...current, analyticsEnabled: result.analyticsEnabled, analyticsNoticeSeen: result.analyticsNoticeSeen ?? true } : current);
  }

  async function leaveLinkedEvent() {
    const eventId = detail?.conversation.linkedEventId;
    if (!eventId || currentLinkedEvent?.role !== "b" || !B_EXITABLE_EVENT_STATES.has(currentLinkedEvent.state)) return;
    if (!window.confirm("退出后会取消你参与这次双人复盘，并停止尚未完成的共同生成。你的私密对话和内容会保留。确认退出？")) return;
    setLeavingLinkedEvent(true);
    setError("");
    try {
      const result = await declineEvent(eventId);
      if (result.error || !result.ok) {
        setError(result.error ?? "这场复盘状态已变化，请刷新后重试。");
        const latest = await getEvent(eventId);
        if (latest.error) {
          setLinkedEvent(null);
          setLinkedEventSync({ eventId, status: "error" });
        } else {
          setLinkedEvent({ eventId, data: latest });
          setLinkedEventSync(null);
        }
        return;
      }
      setLinkedEvent(null);
      await reload();
      setError("你已退出这次双人复盘。私密对话和内容仍会保留。");
    } catch {
      setError("暂时无法退出这次双人复盘，请稍后重试。你的私密内容仍会保留。");
      if (eventId) setLinkedEventSync({ eventId, status: "error" });
    } finally {
      setLeavingLinkedEvent(false);
    }
  }

  function retryLinkedEventStatus() {
    const eventId = detail?.conversation.linkedEventId;
    if (!eventId) return;
    lastEventFocusRefresh.current = Date.now();
    setLinkedEventSync({ eventId, status: "loading" });
    setLinkedEventRefreshKey((key) => key + 1);
  }

  if (loading) return <main className={`${styles.shell} deepwe-app-shell`}><div className={styles.loadingCard}>正在打开你的私密对话…</div></main>;
  if (!account) return <AuthCard onAccount={(user) => { setAccount(user); void reload(); }} />;
  if (!detail) return <main className={`${styles.shell} deepwe-app-shell`}><header className={styles.topbar}><Link href="/app" className={styles.wordmark}>DeepWe <span>深蓝</span></Link></header><section className={styles.loadingCard} role="alert">{error || "这段对话当前不可用。"}<p><Link href="/app">返回所有对话</Link></p></section></main>;

  const visibleMessages = (detail?.messages ?? []).filter((message) => message.status === "current");
  const liveNoteJob = liveJobs.find((item) => item.kind === "notes");
  const liveShareJob = liveJobs.find((item) => item.kind === "share_draft");
  const failedJobs = jobs.filter((item) => item.status === "failed");
  const visibleNotes = detail.notes.filter((note) => note.status === "current" || note.status === "corrected");
  const staleNotes = detail.notes.filter((note) => note.status === "stale");
  const linkedEventId = detail.conversation.linkedEventId;
  const isLinkedB = detail.conversation.linkedSide === "b";
  const canLeaveLinkedEvent = isLinkedB && currentLinkedEvent?.role === "b" && B_EXITABLE_EVENT_STATES.has(currentLinkedEvent.state);
  const hasLinkedSharedResult = isLinkedB && currentLinkedEvent?.role === "b" && Boolean(currentLinkedEvent.merged);
  const canViewLinkedEventProgress = isLinkedB && currentLinkedEvent?.role === "b" && currentLinkedEvent.bConfirmed;

  return (
    <main className={`${styles.shell} deepwe-app-shell`}>
      <header className={styles.topbar}>
        <Link href="/app" className={styles.wordmark}>DeepWe <span>深蓝</span></Link>
        <nav className={styles.topActions} aria-label="空间导航">
          <Link href="/app/couple" className={styles.quietLink}>双人空间</Link>
          <Link href="/app#account-privacy" className={styles.quietLink}>账号与隐私</Link>
          <Link href="/app" className={styles.quietLink}>所有对话</Link>
        </nav>
      </header>
      <div className={styles.chatLayout}>
        <section className={styles.chatMain} aria-label="私密聊天">
          {!account.analyticsNoticeSeen && <section className={styles.analyticsNotice} aria-label="体验数据说明"><h2>关于可选的体验数据</h2><p>为改进页面和服务，我们可记录页面步骤、请求成败及模型用量。不会记录聊天内容、AI 回复、摘要、标题、姓名、键盘输入或录屏。你可拒绝，之后也能在“账号与隐私”关闭；关闭会删除此前的原始体验事件。</p><div><button type="button" onClick={() => void saveAnalyticsPreference(false)} disabled={privacyBusy}>不允许，继续使用</button><button type="button" className={styles.primaryButton} onClick={() => void saveAnalyticsPreference(true)} disabled={privacyBusy}>允许记录非内容数据</button></div>{privacyError && <p className={styles.error} role="alert">{privacyError}</p>}</section>}
          {linkedEventId && <div className={styles.eventReturn}>
            <span>{isLinkedB
              ? hasLinkedSharedResult
                ? "共同理解已生成。你的私密对话和原始消息仍只属于你。"
                : currentLinkedEventSync?.status === "error"
                  ? "暂时无法读取这场复盘的最新状态。你的私密对话和内容仍会保留。"
                  : currentLinkedEvent?.role === "b" && B_EXITABLE_EVENT_STATES.has(currentLinkedEvent.state)
                  ? currentLinkedEvent.bConfirmed
                    ? "你的摘要已确认，共同理解正在生成。可以查看共同复盘进度；等待期间仍可退出本次复盘，私密内容会保留。"
                    : "这场复盘还没有生成共同理解。你可以继续在这里完成自己的表达与摘要确认；对方内容在此之前不可见。"
                  : currentLinkedEvent
                    ? "这场复盘目前不可继续。你的私密对话和内容仍会保留。"
                    : "正在核对这场复盘的状态。你的私密对话和内容仍会保留。"
              : "这段对话已关联到共同复盘。你的私密消息仍只属于你。"}</span>
            {isLinkedB
              ? <>
                  {(hasLinkedSharedResult || canViewLinkedEventProgress) && <Link href={`/e/${encodeURIComponent(linkedEventId)}`}>
                    {hasLinkedSharedResult ? "回到共同复盘" : "查看共同复盘进度"}
                  </Link>}
                  {!hasLinkedSharedResult && currentLinkedEventSync?.status === "error" && <button type="button" className={styles.quietLink} onClick={retryLinkedEventStatus}>重试读取状态</button>}
                  {canLeaveLinkedEvent && <button type="button" className={styles.secondaryButton} onClick={() => void leaveLinkedEvent()} disabled={leavingLinkedEvent}>
                    {leavingLinkedEvent ? "正在退出…" : "退出这次复盘"}
                  </button>}
                </>
              : <Link href={`/e/${encodeURIComponent(linkedEventId)}`}>回到共同复盘</Link>}
          </div>}
          <div className={styles.chatHeading}><div><h1>潜谈</h1><p>{detail.conversation.title ? `${detail.conversation.title} · ` : ""}和深蓝 AI 一起聊聊你想说的事。</p></div><span className={styles.privacyChip}>仅你可见</span></div>
          {error && <p role="alert" className={styles.error}>{error}{conversationRefreshFailed && <> <button type="button" onClick={() => void reload()}>重试读取状态</button></>}</p>}
          {copyNotice && <p className={styles.copyNotice} role="status">{copyNotice}</p>}
          <div className={styles.messageList} aria-live="polite" aria-label="对话内容">
            {!visibleMessages.length && <div className={styles.firstPrompt}><strong>从此刻的你开始。</strong><p>这里不用急着得出结论。你可以补充、纠正，也可以换个话题。</p></div>}
            {visibleMessages.map((message) => <article id={`message-${message.id}`} key={message.id} className={`${styles.message} ${message.role === "user" ? styles.userMessage : styles.assistantMessage}`}>
              <div className={styles.messageRole}>{message.role === "user" ? "我" : "深蓝"}</div>
              {editingMessage === message.id && message.id === latestUserMessageId ? <><textarea value={editText} onChange={(event) => setEditText(event.target.value)} rows={4} aria-label="修改这条消息" disabled={mutationLocked} /><div className={styles.inlineActions}><button type="button" onClick={() => setEditingMessage(null)} disabled={mutationLocked}>取消</button><button type="button" className={styles.actionButton} disabled={mutationLocked || !editText.trim()} onClick={() => void saveMessageEdit(message)}>保存并重新回应</button></div></> : <p className={styles.messageContent}>{message.role === "assistant" ? <ReplyText text={message.content} /> : message.content}</p>}
              {message.role === "user" && <div className={styles.messageActions}>
                <label><input type="checkbox" checked={selectedIds.includes(message.id)} onChange={(event) => { setShareConfirmation(null); setSelectedIds((ids) => event.target.checked ? [...ids, message.id] : ids.filter((id) => id !== message.id)); }} /> 选择整理分享</label>
                {message.id === latestUserMessageId && editingMessage !== message.id && <div className={styles.messageTools} aria-label="这条消息的操作">
                  <button type="button" className={styles.messageToolButton} aria-label="复制我的消息" title="复制" onClick={() => void copyMessage(message)}><MessageIcon name="copy" /></button>
                  <button type="button" className={styles.messageToolButton} aria-label="修改我的最新消息" title="修改" disabled={mutationLocked} onClick={() => { setEditingMessage(message.id); setEditText(message.content); }}><MessageIcon name="edit" /></button>
                  <button type="button" className={styles.messageToolButton} aria-label="删除我的最新消息" title="删除" disabled={mutationLocked} onClick={() => void removeMessage(message)}><MessageIcon name="delete" /></button>
                </div>}
              </div>}
              {message.role === "assistant" && message.id === latestAssistantMessageId && <div className={styles.feedbackActions} aria-label="评价深蓝的最新回应">
                <button type="button" className={styles.messageToolButton} aria-label="复制深蓝的最新回应" title="复制" onClick={() => void copyMessage(message)}><MessageIcon name="copy" /></button>
                <button type="button" className={styles.messageToolButton} aria-label="这条回应有帮助" title="有帮助" aria-pressed={detail.replyFeedback?.rating === "up"} disabled={mutationLocked} onClick={() => toggleReplyFeedbackChoices("up")}><MessageIcon name="up" /></button>
                <button type="button" className={styles.messageToolButton} aria-label="这条回应不合适" title="不合适" aria-pressed={detail.replyFeedback?.rating === "down"} disabled={mutationLocked} onClick={() => toggleReplyFeedbackChoices("down")}><MessageIcon name="down" /></button>
                {feedbackChoicesFor && <div className={styles.feedbackChoices} aria-label={feedbackChoicesFor === "up" ? "可选的正向反馈原因" : "可选的改进方向"}>
                  {REPLY_FEEDBACK_REASONS[feedbackChoicesFor].map(({ value, label }) => <button key={value} type="button" aria-pressed={detail.replyFeedback?.reason === value} disabled={mutationLocked} onClick={() => void saveReplyFeedback(feedbackChoicesFor === "up" ? "up" : "down", detail.replyFeedback?.reason === value ? null : value)}>{label}</button>)}
                </div>}
              </div>}
            </article>)}
          </div>
            {liveJobs.map((currentJob) => <div key={currentJob.id} className={styles.jobNotice} role="status"><span>{currentJob.kind === "reply" ? currentJob.status === "processing" ? "正在回应你…" : "正在准备回复…" : currentJob.kind === "notes" ? "正在整理对话要点…" : "正在准备分享草稿…"}</span>{jobStatusErrors[currentJob.id] && <><span>{jobStatusErrors[currentJob.id]}</span><button type="button" onClick={() => setJobPollRefreshKey((key) => key + 1)}>重试读取状态</button></>}<button type="button" onClick={() => void stopJob(currentJob)}>暂停</button></div>)}
          {failedJobs.map((failedJob) => <div key={failedJob.id} className={styles.jobNotice} role="alert"><span>{failedJob.kind === "reply" ? "刚才的回复没有完成，你的消息还在。" : failedJob.kind === "notes" ? "对话要点没有整理完成，聊天内容还在。" : "分享草稿没有生成完成，尚未分享任何内容。"}</span><button type="button" onClick={() => void retryJob(failedJob)}>重试</button></div>)}
          {jobs.filter((item) => item.status === "cancelled").map((cancelledJob) => <p key={cancelledJob.id} className={styles.statusLine} role="status">{cancelledJob.kind === "reply" ? "这次回复已暂停。你可以继续说，或稍后回来。" : "这项整理已暂停。"}</p>)}
          {endPromptOpen ? <section className={styles.outcomePrompt} aria-labelledby="outcome-title"><h2 id="outcome-title">和刚开始相比，现在感觉如何？</h2><p>没有标准答案。你可以跳过，也可以不反馈直接离开。</p><div className={styles.outcomeChoices}>{([["lighter", "轻松了一点"], ["same", "差不多"], ["worse", "更难受了"], ["unclear", "现在说不清"]] as const).map(([value, label]) => <button key={value} type="button" aria-pressed={endResult === value} onClick={() => { setEndResult(value); if (value !== "same" && value !== "worse") setEndReason(""); }}>{label}</button>)}</div>{(endResult === "same" || endResult === "worse") && <div className={styles.outcomeReasons}><p>如果愿意，哪一点最影响你？</p>{["没有被理解", "问题太多", "建议没帮助", "等待太久", "暂时不想继续"].map((reason) => <button key={reason} type="button" aria-pressed={endReason === reason} onClick={() => setEndReason((current) => current === reason ? "" : reason)}>{reason}</button>)}</div>}<div className={styles.outcomeActions}><button type="button" onClick={() => setEndPromptOpen(false)}>继续聊</button><button type="button" onClick={() => router.push("/app")}>不反馈，返回私密空间</button><button type="button" onClick={() => void submitEndFeedback("skipped")}>跳过反馈并返回</button><button type="button" className={styles.primaryButton} disabled={!endResult} onClick={() => void submitEndFeedback(endResult as "lighter" | "same" | "worse" | "unclear")}>提交并结束</button></div></section> : <form className={styles.chatComposer} onSubmit={submitMessage}>
            <label htmlFor="chat-message">继续说</label>
            {staleEditDraft && <div className={styles.statusLine} role="status"><span>对话已有新一轮，你之前的修改草稿仍保留。</span>{composer.trim() ? <span>先发送或清空当前输入，再把草稿作为新消息发送。</span> : <button type="button" onClick={() => { setComposer(staleEditDraft); setEditingMessage(null); setEditText(""); window.requestAnimationFrame(() => composerRef.current?.focus()); }}>把修改作为新消息</button>}</div>}
            <textarea ref={composerRef} id="chat-message" value={composer} onChange={(event) => setComposer(event.target.value)} rows={3} maxLength={6000} placeholder="写下你现在想说的……" disabled={busy} />
            <div className={styles.composerFooter}><span>发送后仍只对你可见</span><div className={styles.composerButtons}><button type="button" className={styles.quietLink} onClick={beginEnding}>今天先到这里</button><button type="submit" className={styles.primaryButton} disabled={busy || Boolean(liveReplyJob) || !composer.trim()}>{busy ? "正在发送…" : "发送"}</button></div></div>
          </form>}
        </section>
        <aside className={styles.chatAside}>
          <details className={`${styles.asideSection} ${styles.notePanel}`}>
            <summary className={styles.noteSummary}><h2>对话要点</h2><span>{visibleNotes.length} 条</span></summary>
            <p>这些要点只属于你。你可以按需整理，再决定是否核对或修正。</p>
            <button type="button" className={styles.secondaryButton} onClick={() => void refreshNotes()} disabled={busy || Boolean(liveNoteJob) || !visibleMessages.length}>整理当前要点</button>
            {visibleNotes.map((note) => <div key={note.id} className={styles.noteItem}>
              <span>{note.kind === "user_statement" ? "原话要点" : note.kind === "unknown" ? "还不确定" : "暂时的理解"}{note.status === "corrected" ? " · 你已修正" : " · 待你核对"}</span>
              <p>{note.status === "corrected" && note.correction ? note.correction : note.content}</p>
              <div className={styles.sourceLinks}>{note.sourceMessageIds.map((sourceId, index) => <button key={sourceId} type="button" onClick={() => document.getElementById(`message-${sourceId}`)?.scrollIntoView({ behavior: "smooth", block: "center" })}>查看来源 {index + 1}</button>)}</div>
              {editingNoteId === note.id ? <>
                <label className={styles.noteCorrection}>你的核对或修正<textarea value={noteText[note.id] ?? note.correction ?? note.content} onChange={(event) => setNoteText((old) => ({ ...old, [note.id]: event.target.value }))} rows={3} disabled={savingNoteId === note.id} /></label>
                <div className={styles.inlineActions}><button type="button" onClick={() => setEditingNoteId(null)} disabled={savingNoteId === note.id}>取消</button><button type="button" className={styles.actionButton} disabled={savingNoteId === note.id} onClick={() => void saveNote(note)}>{savingNoteId === note.id ? "正在保存…" : "保存我的修正"}</button></div>
              </> : <button type="button" aria-expanded="false" onClick={() => { setEditingNoteId(note.id); setNoteText((old) => old[note.id] === undefined ? { ...old, [note.id]: note.correction ?? note.content } : old); }}>核对 / 修正</button>}
            </div>)}
            {!visibleNotes.length && <p className={styles.statusLine}>整理后，你的私密要点会显示在这里。</p>}
            {!!staleNotes.length && <details className={styles.staleNotes}>
              <summary>查看已过期的 {staleNotes.length} 条要点</summary>
              {staleNotes.map((note) => <div key={note.id} className={`${styles.noteItem} ${styles.staleNote}`}>
                <span>已过期 · {note.kind === "user_statement" ? "原话要点" : note.kind === "unknown" ? "还不确定" : "暂时的理解"}</span>
                <p>{note.correction ? `曾修正为：${note.correction}；原要点：${note.content}` : note.content}</p>
                <div className={styles.sourceLinks}>{note.sourceMessageIds.map((sourceId, index) => <button key={sourceId} type="button" onClick={() => document.getElementById(`message-${sourceId}`)?.scrollIntoView({ behavior: "smooth", block: "center" })}>查看来源 {index + 1}</button>)}</div>
              </div>)}
            </details>}
          </details>
          <details className={styles.asideSection}>
            <summary className={styles.responsePreferenceSummary}>这段对话的回应偏好</summary>
            <p>你主动选择的反馈原因会用于调整这段潜谈里的回应方式。只作用于本段对话，不用于其他潜谈，也不用于模型训练。</p>
            {detail.responsePreferences.length ? <ul className={styles.responsePreferenceList}>{detail.responsePreferences.map((reason) => <li key={reason}>{RESPONSE_PREFERENCE_LABELS[reason as ReplyFeedbackReason] ?? reason}</li>)}</ul> : <p className={styles.statusLine}>目前没有已选的回应偏好。</p>}
            {(detail.responsePreferences.length > 0 || detail.replyFeedback) && <button type="button" className={styles.secondaryButton} onClick={() => void clearResponsePreferences()} disabled={mutationLocked}>清除本段回应偏好</button>}
          </details>
          <section className={styles.asideSection}><h2>由你决定是否分享</h2><p>选中本人消息后，AI 只会基于这些消息整理草稿。草稿不会自动发送。</p>
            <button type="button" className={styles.secondaryButton} onClick={() => void prepareShare()} disabled={busy || Boolean(liveShareJob) || !selectedIds.length}>整理一份分享草稿{selectedIds.length ? ` · ${selectedIds.length}` : ""}</button>
            {(detail.shareDrafts ?? []).filter((item) => item.status === "draft").map((savedDraft) => <button key={savedDraft.id} type="button" className={styles.savedDraftLink} onClick={() => void openDraft(savedDraft.id)}>继续核对分享草稿 · v{savedDraft.version}</button>)}
            {sharing && draft && <div className={styles.draftEditor}><p>只分享这份已核对的中性摘要</p><textarea value={draftText} onChange={(event) => { draftEditRevisionRef.current += 1; setShareConfirmation(null); setDraftText(event.target.value); }} rows={8} aria-label="修改分享草稿" disabled={savingDraft || confirmingShare} /><div className={styles.inlineActions}><button type="button" onClick={() => { setShareConfirmation(null); setSharing(false); }} disabled={savingDraft || confirmingShare}>稍后再看</button><button type="button" className={styles.secondaryButton} onClick={() => void saveDraft()} disabled={savingDraft || confirmingShare || draftText === draft.content}>{savingDraft ? "正在保存…" : "保存修改"}</button></div><button type="button" className={styles.primaryButton} onClick={startShareConfirmation} disabled={busy || confirmingShare || savingDraft || draftText !== draft.content || draft.status !== "draft" || draftId !== draft.id}>{isLinkedB ? "继续确认我的摘要" : "继续确认分享这一版"}</button>{shareConfirmation && <div className={styles.shareConfirmation} role="group" aria-label={isLinkedB ? "确认将摘要用于这场复盘" : "确认分享并邀请伴侣"}>
              <p>{isLinkedB
                ? "只将你检查确认的这一版摘要作为你在这场复盘中的表达；你的私密原话、这段私密对话和 AI 回复不会分享。"
                : "只把你检查确认的这一版摘要分享给已绑定的伴侣，并发送站内复盘邀请；你的私密原话、这段私密对话和 AI 回复不会分享。"}</p>
              <div className={styles.shareConfirmationActions}><button type="button" onClick={() => setShareConfirmation(null)} disabled={confirmingShare}>返回检查</button><button type="button" className={styles.primaryButton} onClick={() => void confirmShare()} disabled={confirmingShare || savingDraft}>{confirmingShare ? "正在确认…" : isLinkedB ? "确认并返回共同复盘" : "确认分享并邀请伴侣"}</button></div>
              <small>确认对象：当前草稿 v{draft.version}</small>
            </div>}<small>版本 {draft.version} · 只有确认后才会进入共同空间</small></div>}
            {sharing && !draft && draftId && <p className={styles.statusLine} role="status">{liveShareJob
              ? "正在整理草稿。对话仍可继续，草稿完成后会在这里打开。"
              : failedJobs.some((item) => item.kind === "share_draft")
                ? "草稿尚未完成。你可以重试，或继续私密对话。"
                : "分享草稿状态已更新。请点击上方的“继续核对分享草稿”读取当前内容。"}</p>}
          </section>
        </aside>
      </div>
    </main>
  );
}
