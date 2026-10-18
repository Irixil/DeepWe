import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";

// This file deliberately never opens a project database, runs a worker, or
// persists a snapshot. Every account, session and message below is synthetic.
const offline = vi.hoisted(() => {
  process.env.DEEPWE_DATABASE_PATH = ":memory:";
  process.env.DATA_DIR = "/tmp/deepwe-shared-deletion-offline";
  return {
    wakeShared: vi.fn(),
    wakePrivate: vi.fn(),
    persist: vi.fn().mockResolvedValue(undefined),
    fetch: vi.fn(() => { throw new Error("Unexpected network call in offline deletion regression"); }),
  };
});
vi.mock("./ai-worker.js", () => ({ wakeAiWorker: offline.wakeShared }));
vi.mock("./private-ai-worker.js", () => ({ wakePrivateWorker: offline.wakePrivate }));
vi.mock("./persistence.js", () => ({ persistDatabaseIfChanged: offline.persist }));

import * as store from "./db.js";
import * as core from "./private-core.js";
import { getPrivateMemory, syncPrivateMemoryFromNotes, updatePrivateMemorySettings } from "./private-memory.js";
import { api } from "./routes.js";

type Actor = { id: string; cookie: string };
type PrivateFixture = {
  actor: Actor;
  conversationId: string;
  sourceId: string;
  queuedJobId: string;
};
type ReadyDraft = { id: string; version: number; content: string };

function actor(name: string): Actor {
  const nonce = randomUUID();
  const user = store.createUser(`${nonce}@shared-deletion.test`, `合成${name}`, "synthetic-hash", "synthetic-salt");
  const token = `synthetic-session-${nonce}`;
  store.createAccountSession(user.id, createHash("sha256").update(token).digest("hex"), Date.now() + 60_000);
  return { id: user.id, cookie: `dw_account=${token}` };
}

async function request(who: Actor, path: string, method = "POST", body?: unknown) {
  return api.request(path, {
    method,
    headers: { Cookie: who.cookie, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function finishSyntheticJob(jobId: string, result: unknown) {
  expect(store.db.prepare("UPDATE private_jobs SET status='processing' WHERE id=? AND status='queued'").run(jobId).changes).toBe(1);
  expect(core.completePrivateJob(jobId, result)).toBe(true);
}

function seedPrivate(who: Actor, conversationId: string): PrivateFixture {
  const source = core.addUserMessage(who.id, conversationId, "合成案例：我希望讨论安排；这句话只属于本人的私聊。")!;
  expect(source.jobId).toBeTruthy();
  finishSyntheticJob(source.jobId!, { reply: "合成离线回复：可以先写下你自己的想法。" });
  const assistant = core.listCurrentMessages(conversationId).find(message => message.role === "assistant")!;
  expect(assistant).toBeTruthy();
  const notes = core.createNotesJob(who.id, conversationId)!;
  finishSyntheticJob(notes.id, [{ kind: "user_statement", content: "本人希望讨论安排", sourceMessageIds: [source.message.id] }]);
  const version = core.getConversationById(who.id, conversationId)!.version;
  expect(core.setLatestReplyFeedback(who.id, conversationId, assistant.id, "up", "clear", version)).toMatchObject({ feedback: { rating: "up", reason: "clear" } });
  const queuedJob = core.createNotesJob(who.id, conversationId)!;
  expect(queuedJob.status).toBe("queued");
  return { actor: who, conversationId, sourceId: source.message.id, queuedJobId: queuedJob.id };
}

async function readyDraft(privateState: PrivateFixture, content: string): Promise<ReadyDraft> {
  const response = await request(privateState.actor, `/conversations/${privateState.conversationId}/share-drafts`, "POST", { sourceMessageIds: [privateState.sourceId] });
  expect(response.status).toBe(202);
  const created = await response.json() as { draftId: string; jobId: string };
  finishSyntheticJob(created.jobId, { content });
  const draft = core.getShareDraft(privateState.actor.id, privateState.conversationId, created.draftId)!;
  expect(draft).toMatchObject({ content, status: "draft", version: 1 });
  return { id: draft.id, content: draft.content, version: draft.version };
}

async function confirm(privateState: PrivateFixture, draft: ReadyDraft) {
  return request(privateState.actor, `/conversations/${privateState.conversationId}/share-drafts/${draft.id}/confirm`, "POST", { version: draft.version, invitePartner: true });
}

function privateSnapshot(privateState: PrivateFixture) {
  const conversation = core.getOwnedConversation(privateState.actor.id, privateState.conversationId)!;
  // Only link/side/updated_at may change on shared deletion. Private content and
  // its input version stay valid, including already queued private work.
  const { linked_event_id: _event, linked_side: _side, updated_at: _updated, ...stableConversation } = conversation;
  return {
    conversation: stableConversation,
    messages: store.db.prepare("SELECT * FROM private_messages WHERE conversation_id=? ORDER BY id").all(privateState.conversationId),
    notes: store.db.prepare("SELECT * FROM private_notes WHERE conversation_id=? ORDER BY id").all(privateState.conversationId),
    feedback: store.db.prepare("SELECT * FROM private_reply_feedback WHERE conversation_id=? ORDER BY assistant_message_id").all(privateState.conversationId),
    jobs: store.db.prepare("SELECT * FROM private_jobs WHERE conversation_id=? ORDER BY id").all(privateState.conversationId),
  };
}

async function sharedFixture() {
  const a = actor("A"), b = actor("B"), outsider = actor("第三人");
  const invite = store.createPartnerInvite(a.id)!;
  expect(invite).toBeTruthy();
  expect(store.acceptPartnerInvite(invite.code, b.id)).toBe(true);
  expect(store.approvePartnerBindingRequest(a.id, invite.id)).toBe(true);
  const aPrivate = seedPrivate(a, core.createConversation(a.id, "合成 A 私聊").id);
  const aDraft = await readyDraft(aPrivate, "旧事件 A 本人确认的合成分享内容");
  const aConfirmed = await confirm(aPrivate, aDraft);
  expect(aConfirmed.status).toBe(201);
  const oldEventId = (await aConfirmed.json() as { eventId: string }).eventId;
  expect(store.getEvent(oldEventId)?.state).toBe("waiting_b");
  expect(store.acceptPartnerEventInvite(oldEventId, b.id)).toBeTruthy();
  const bConversation = core.getOrCreateEventConversation(b.id, oldEventId, "b")!;
  expect(bConversation).toBeTruthy();
  const bPrivate = seedPrivate(b, bConversation.id);
  const bDraft = await readyDraft(bPrivate, "旧事件 B 本人确认的合成分享内容");
  const bConfirmed = await confirm(bPrivate, bDraft);
  expect(bConfirmed.status).toBe(201);
  expect(await bConfirmed.json()).toMatchObject({ eventId: oldEventId });
  expect(store.getEvent(oldEventId)?.state).toBe("b_summary");
  // Visible synthetic shared artifacts make accidental reuse observable.
  store.upsertMerged(oldEventId, JSON.stringify({ common_ground: "旧事件共同理解合成标记" }));
  store.setChoice(oldEventId, "a", "旧事件 A 约定合成标记");
  store.setChoice(oldEventId, "b", "旧事件 B 约定合成标记");
  const otherEvent = store.createEvent("无关事件合成标记", outsider.id);
  const otherConversation = core.createConversation(outsider.id, "第三人私聊", { eventId: otherEvent.id, side: "a" });
  store.upsertPerspective(otherEvent.id, "a", "第三人原话合成标记");
  store.upsertMerged(otherEvent.id, JSON.stringify({ common_ground: "无关共同理解合成标记" }));
  store.setChoice(otherEvent.id, "a", "无关约定合成标记");
  return { a, b, outsider, aPrivate, bPrivate, aDraft, bDraft, oldEventId, otherEventId: otherEvent.id, otherConversationId: otherConversation.id };
}

async function deleteTogether(fixture: Awaited<ReturnType<typeof sharedFixture>>) {
  const first = await request(fixture.a, `/events/${fixture.oldEventId}/deletion-request`);
  expect(first.status).toBe(200);
  expect(await first.json()).toEqual({ ok: true, status: "pending" });
  const second = await request(fixture.b, `/events/${fixture.oldEventId}/deletion-request`);
  expect(second.status).toBe(200);
  expect(await second.json()).toEqual({ ok: true, status: "deleted" });
  expect(store.getEvent(fixture.oldEventId)).toBeUndefined();
}

function unrelatedSnapshot(fixture: Awaited<ReturnType<typeof sharedFixture>>) {
  return {
    user: store.getUserById(fixture.outsider.id),
    event: store.getEvent(fixture.otherEventId),
    conversation: core.getOwnedConversation(fixture.outsider.id, fixture.otherConversationId),
    perspective: store.getPerspective(fixture.otherEventId, "a"),
    merged: store.getMerged(fixture.otherEventId),
    agreement: store.getAgreement(fixture.otherEventId),
  };
}

function emulateLegacyOrphan(eventId: string) {
  // Emulate the previously shipped event-only deletion, intentionally keeping
  // converted drafts and A/B links. Never call the corrected deletion function.
  store.db.transaction(() => {
    for (const table of ["ai_jobs", "event_user_visibility", "event_deletion_requests", "partner_event_invite_snoozes", "guide_sessions", "guide_messages", "message_feedback", "agreements", "merged", "perspectives"]) {
      store.db.prepare(`DELETE FROM ${table} WHERE event_id=?`).run(eventId);
    }
    store.db.prepare("DELETE FROM events WHERE id=?").run(eventId);
  })();
  expect(store.getEvent(eventId)).toBeUndefined();
}

beforeAll(() => {
  expect(store.db.pragma("database_list")).toEqual([expect.objectContaining({ name: "main", file: "" })]);
  vi.stubGlobal("fetch", offline.fetch);
});
afterEach(() => { expect(offline.fetch).not.toHaveBeenCalled(); });

describe("共同删除保留私聊并允许本人重新分享（真实内存 core/HTTP handler）", () => {
  it("单方请求尚未获得对方确认时保留双方关联和旧草稿幂等确认", async () => {
    const f = await sharedFixture();
    const before = [privateSnapshot(f.aPrivate), privateSnapshot(f.bPrivate)];
    const response = await request(f.a, `/events/${f.oldEventId}/deletion-request`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, status: "pending" });
    expect(store.getEvent(f.oldEventId)).toBeTruthy();
    for (const [privateState, side] of [[f.aPrivate, "a"], [f.bPrivate, "b"]] as const) {
      expect(core.getOwnedConversation(privateState.actor.id, privateState.conversationId)).toMatchObject({ linked_event_id: f.oldEventId, linked_side: side });
    }
    expect([privateSnapshot(f.aPrivate), privateSnapshot(f.bPrivate)]).toEqual(before);
    for (const [privateState, draft] of [[f.aPrivate, f.aDraft], [f.bPrivate, f.bDraft]] as const) {
      const retry = await confirm(privateState, draft);
      expect(retry.status).toBe(201);
      expect(await retry.json()).toMatchObject({ eventId: f.oldEventId });
    }
  });

  it("单方从记录中隐藏共享事件不提前解绑或替对方永久删除", async () => {
    const f = await sharedFixture();
    const before = [privateSnapshot(f.aPrivate), privateSnapshot(f.bPrivate)];
    const response = await request(f.a, `/events/${f.oldEventId}`, "DELETE");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, hiddenOnly: true });
    expect(store.getEvent(f.oldEventId)).toBeTruthy();
    expect(store.db.prepare("SELECT user_id FROM event_user_visibility WHERE event_id=?").all(f.oldEventId)).toEqual([{ user_id: f.a.id }]);
    expect(core.getOwnedConversation(f.a.id, f.aPrivate.conversationId)?.linked_event_id).toBe(f.oldEventId);
    expect(core.getOwnedConversation(f.b.id, f.bPrivate.conversationId)?.linked_event_id).toBe(f.oldEventId);
    expect([privateSnapshot(f.aPrivate), privateSnapshot(f.bPrivate)]).toEqual(before);
  });

  it("双确认后解除双方关联，保留私聊正文、笔记、反馈、输入版本及 queued 私聊任务", async () => {
    const f = await sharedFixture();
    const before = [privateSnapshot(f.aPrivate), privateSnapshot(f.bPrivate)];
    const other = unrelatedSnapshot(f);
    await deleteTogether(f);
    for (const privateState of [f.aPrivate, f.bPrivate]) {
      expect.soft(core.getOwnedConversation(privateState.actor.id, privateState.conversationId)).toMatchObject({ status: "active", linked_event_id: null, linked_side: null });
      expect.soft(core.listCurrentMessages(privateState.conversationId)).toHaveLength(2);
      expect.soft(core.listCurrentNotes(privateState.conversationId)).toHaveLength(1);
      expect.soft(core.getPrivateJob(privateState.actor.id, privateState.conversationId, privateState.queuedJobId)?.status).toBe("queued");
    }
    expect.soft([privateSnapshot(f.aPrivate), privateSnapshot(f.bPrivate)]).toEqual(before);
    expect.soft(unrelatedSnapshot(f)).toEqual(other);
    expect.soft(store.getMerged(f.oldEventId)).toBeUndefined();
    expect.soft(store.getAgreement(f.oldEventId)).toBeUndefined();
    expect.soft(store.db.prepare("SELECT * FROM perspectives WHERE event_id=?").all(f.oldEventId)).toEqual([]);
    expect.soft(store.db.prepare("SELECT * FROM ai_jobs WHERE event_id=?").all(f.oldEventId)).toEqual([]);
  });

  it("双方删除确认清除 queued/processing 合并任务，迟到结果不能重建共同内容", async () => {
    const f = await sharedFixture();
    const queuedMerge = store.enqueueAiJob(f.oldEventId, "merge_initial", "b");
    const processingMerge = store.enqueueAiJob(f.oldEventId, "merge_correction", "b");
    expect(store.db.prepare("UPDATE ai_jobs SET status='processing' WHERE id=? AND status='queued'").run(processingMerge.id).changes).toBe(1);
    const claimedMerge = store.getAiJob(processingMerge.id)!;

    await deleteTogether(f);
    expect(store.db.prepare("SELECT * FROM ai_jobs WHERE event_id=?").all(f.oldEventId)).toEqual([]);

    store.completeMergeAiJob(claimedMerge, JSON.stringify({ common_ground: "迟到合并不得复活的合成内容" }));
    expect(store.getEvent(f.oldEventId)).toBeUndefined();
    expect(store.getMerged(f.oldEventId)).toBeUndefined();
    expect(store.getAiJob(queuedMerge.id)).toBeUndefined();
    expect(store.getAiJob(processingMerge.id)).toBeUndefined();
  });

  it("任一实际参与者撤回分享后终止共同产物与迟到任务，但保留双方私聊和 Memory", async () => {
    const f = await sharedFixture();
    const privateBefore = [f.aPrivate, f.bPrivate].map(state => privateSnapshot(state));
    for (const privateState of [f.aPrivate, f.bPrivate]) {
      expect(updatePrivateMemorySettings(privateState.actor.id, true, 1)).not.toHaveProperty("error");
      const notes = store.db.prepare(`SELECT id,kind,content,correction,source_message_ids AS sourceMessageIds,
        source_message_versions AS sourceMessageVersions,status,version FROM private_notes WHERE conversation_id=? AND status IN ('current','corrected')`)
        .all(privateState.conversationId) as Array<{ id: string; kind: "user_statement" | "tentative_understanding" | "unknown"; content: string; correction: string | null; sourceMessageIds: string; sourceMessageVersions: string; status: string; version: number }>;
      syncPrivateMemoryFromNotes(privateState.actor.id, privateState.conversationId, notes);
    }
    const memoryBefore = [f.a, f.b].map(actor => getPrivateMemory(actor.id));

    expect(store.transition(f.oldEventId, "b_summary", "merged")).toBe(true);
    store.upsertMerged(f.oldEventId, JSON.stringify({ common_ground: "需在撤回后隐藏的共同内容" }));
    expect(store.transition(f.oldEventId, "merged", "agreement_proposed")).toBe(true);
    store.setChoice(f.oldEventId, "a", "撤回前 A 的行动");
    store.setChoice(f.oldEventId, "b", "撤回前 B 的行动");
    store.markAgreementDone(f.oldEventId);
    expect(store.transition(f.oldEventId, "agreement_proposed", "done")).toBe(true);
    store.setReview(f.oldEventId, "a", JSON.stringify({ executed: "A 的复访", effect: "有效", next: "继续" }));
    store.setReview(f.oldEventId, "b", JSON.stringify({ executed: "B 的复访", effect: "有效", next: "继续" }));
    expect(store.transition(f.oldEventId, "done", "completed")).toBe(true);
    store.setRisk(f.oldEventId, "violence", "b");

    const queued = store.enqueueAiJob(f.oldEventId, "merge_initial", "b");
    const processing = store.enqueueAiJob(f.oldEventId, "merge_correction", "a");
    const failed = store.enqueueAiJob(f.oldEventId, "merge_correction", "b");
    expect(store.db.prepare("UPDATE ai_jobs SET status='processing' WHERE id=? AND status='queued'").run(processing.id).changes).toBe(1);
    expect(store.db.prepare("UPDATE ai_jobs SET status='failed',error='synthetic failure',error_code='AI_UNAVAILABLE' WHERE id=? AND status='queued'").run(failed.id).changes).toBe(1);
    const lateJob = store.getAiJob(processing.id)!;

    // The event title is user-entered shared text, so it must also disappear
    // from all participant-facing reads after consent is revoked.
    expect(store.renameEvent(f.oldEventId, f.a.id, "撤回后不得再显示的标题合成标记")).toBe(true);

    const revoke = await request(f.a, `/events/${f.oldEventId}/sharing/revoke`);
    expect(revoke.status).toBe(200);
    expect(await revoke.json()).toMatchObject({ ok: true, state: "sharing_revoked", ownConversationId: f.aPrivate.conversationId });
    expect(store.getEvent(f.oldEventId)?.state).toBe("sharing_revoked");
    const legacyCookieOnly = await api.request(`/events/${f.oldEventId}/sharing/revoke`, {
      method: "POST", headers: { Cookie: `dw_${f.oldEventId}=${store.getEvent(f.oldEventId)!.a_token}` },
    });
    expect(legacyCookieOnly.status).toBe(401);
    for (const id of [queued.id, processing.id, failed.id]) expect(store.getAiJob(id)?.status).toBe("cancelled");
    store.completeMergeAiJob(lateJob, JSON.stringify({ common_ground: "迟到内容不得写回" }));
    expect(store.getMerged(f.oldEventId)?.content).toContain("需在撤回后隐藏");
    expect(store.getMerged(f.oldEventId)).toMatchObject({ a_confirmed: 0, b_confirmed: 0 });

    for (const [actor, privateState] of [[f.a, f.aPrivate], [f.b, f.bPrivate]] as const) {
      const response = await request(actor, `/events/${f.oldEventId}` , "GET");
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        title: "分享已停止", state: "sharing_revoked", sharingRevoked: true, ownConversationId: privateState.conversationId,
        risk: privateState.actor.id === f.b.id ? "violence" : "none",
        aSummary: null, bSummary: null, aConfirmed: false, bConfirmed: false,
        merged: null, mergedVersion: null, mergedAConfirmed: false, mergedBConfirmed: false,
        choices: {}, dueAt: null, reviewAvailable: false, aReview: null, bReview: null,
        aiJobKind: null, aiJobId: null, aiJobAttempt: null, aiJobStatus: "idle", aiJobError: null, aiJobErrorCode: null,
      });
    }
    expect((await request(f.b, `/events/${f.oldEventId}/sharing/revoke`)).status).toBe(200);
    expect((await request(f.outsider, `/events/${f.oldEventId}`, "GET")).status).toBe(404);
    expect((await request(f.outsider, `/events/${f.oldEventId}/sharing/revoke`)).status).toBe(404);
    const eventList = await request(f.a, "/events", "GET");
    expect(eventList.status).toBe(200);
    expect((await eventList.json() as {events:Array<{id:string;title:string;state:string;hasPartner:boolean}>}).events.find(event=>event.id===f.oldEventId)).toMatchObject({title:"分享已停止",state:"sharing_revoked",hasPartner:true});
    for (const actor of [f.a, f.b]) {
      const exported = await request(actor, "/account/export", "GET");
      expect(exported.status).toBe(200);
      const { data } = await exported.json() as { data: { conversations: Array<{ id: string; title: string; sharedUnderstanding: unknown; agreement: unknown; mySummary: unknown }> } };
      expect(data.conversations.find(event => event.id === f.oldEventId)).toMatchObject({ title: "分享已停止", sharedUnderstanding: null, agreement: null, mySummary: null });
    }

    for (const [privateState, draft] of [[f.aPrivate, f.aDraft], [f.bPrivate, f.bDraft]] as const) {
      const retry = await confirm(privateState, draft);
      expect([404, 409]).toContain(retry.status);
      expect(await retry.json()).not.toHaveProperty("eventId");
      expect(core.getOwnedConversation(privateState.actor.id, privateState.conversationId)).toMatchObject({ linked_event_id: null, linked_side: null });
    }
    expect([f.aPrivate, f.bPrivate].map(state => privateSnapshot(state))).toEqual(privateBefore);
    expect([f.a, f.b].map(actor => getPrivateMemory(actor.id))).toEqual(memoryBefore);

    expect((await request(f.a, `/events/${f.oldEventId}/summary/confirm`, "POST", { edited: { observation: "旧摘要不能恢复" } })).status).toBe(409);
    expect((await request(f.b, `/events/${f.oldEventId}/b-summary/confirm`, "POST", { edited: { observation: "旧摘要不能恢复" } })).status).toBe(409);
    expect((await request(f.a, `/events/${f.oldEventId}/merged/confirm`, "POST", { expectedVersion: store.getMerged(f.oldEventId)!.version })).status).toBe(409);
    expect((await request(f.a, `/events/${f.oldEventId}/agreement`, "POST", { choice: "旧行动不能提交" })).status).toBe(409);
    expect((await request(f.b, `/events/${f.oldEventId}/review`, "POST", { executed: "旧复访", effect: "有效", next: "继续" })).status).toBe(409);
    expect((await request(f.a, `/events/${f.oldEventId}/ai/retry`, "POST", { expectedJobId: failed.id, expectedAttempt: 0 })).status).toBe(409);
    expect((await request(f.a, `/events/${f.oldEventId}/withdraw/resubmit`)).status).toBe(409);

    await deleteTogether(f);
    expect(store.getEvent(f.oldEventId)).toBeUndefined();
  });

  it("A 撤回刚分享的定向邀请后，B 不能再接受旧事件", async () => {
    const a = actor("待接受 A"), b = actor("待接受 B");
    const invite = store.createPartnerInvite(a.id)!;
    expect(store.acceptPartnerInvite(invite.code, b.id)).toBe(true);
    expect(store.approvePartnerBindingRequest(a.id, invite.id)).toBe(true);
    const privateState = seedPrivate(a, core.createConversation(a.id, "待接受分享 A 私聊").id);
    const draft = await readyDraft(privateState, "本人已确认但尚未被接受的合成分享");
    const published = await confirm(privateState, draft);
    expect(published.status).toBe(201);
    const { eventId } = await published.json() as { eventId: string };

    expect((await request(a, `/events/${eventId}/sharing/revoke`)).status).toBe(200);
    expect((await request(b, `/partner/event-invites/${eventId}/accept`)).status).toBe(409);
    expect(store.getEvent(eventId)).toMatchObject({ state: "sharing_revoked", partner_target_user_id: null });
  });

  it("双确认后取消旧 converted 草稿、清除事件 ID、增加草稿版本并保留草稿正文", async () => {
    const f = await sharedFixture();
    await deleteTogether(f);
    for (const [privateState, draft] of [[f.aPrivate, f.aDraft], [f.bPrivate, f.bDraft]] as const) {
      expect.soft(core.getShareDraft(privateState.actor.id, privateState.conversationId, draft.id)).toMatchObject({ status: "cancelled", version: draft.version + 1, content: draft.content, sourceMessageIds: [privateState.sourceId] });
      expect.soft(store.db.prepare("SELECT event_id FROM private_share_drafts WHERE id=?").get(draft.id)).toEqual({ event_id: null });
    }
  });

  it("删除后重放双方旧确认不能成功返回已删除的事件，也不能重建旧共享数据", async () => {
    const f = await sharedFixture();
    await deleteTogether(f);
    for (const [privateState, draft] of [[f.aPrivate, f.aDraft], [f.bPrivate, f.bDraft]] as const) {
      const response = await confirm(privateState, draft);
      expect.soft([404, 409]).toContain(response.status);
      expect.soft(await response.json()).not.toHaveProperty("eventId");
      expect.soft(core.confirmShareDraft(privateState.actor.id, privateState.conversationId, draft.id, draft.version)).toHaveProperty("error");
    }
    expect.soft(store.getEvent(f.oldEventId)).toBeUndefined();
    expect.soft(store.getMerged(f.oldEventId)).toBeUndefined();
    expect.soft(store.getAgreement(f.oldEventId)).toBeUndefined();
  });

  it("原 B 主动生成并确认新草稿后成为新 A，创建独立 waiting_b 事件且不复活旧共享数据", async () => {
    const f = await sharedFixture();
    const other = unrelatedSnapshot(f);
    await deleteTogether(f);
    const content = "删除后由原 B 本人新确认的合成分享内容";
    const newDraft = await readyDraft(f.bPrivate, content);
    const response = await confirm(f.bPrivate, newDraft);
    expect(response.status).toBe(201);
    const result = await response.json() as { eventId: string };
    expect(result.eventId).not.toBe(f.oldEventId);
    expect(store.getEvent(result.eventId)).toMatchObject({ state: "waiting_b", a_user_id: f.b.id, b_user_id: null, partner_target_user_id: f.a.id, a_conversation_id: f.bPrivate.conversationId, b_conversation_id: null });
    expect(core.getOwnedConversation(f.b.id, f.bPrivate.conversationId)).toMatchObject({ linked_event_id: result.eventId, linked_side: "a" });
    expect(store.getPerspective(result.eventId, "a")?.summary).toBe(JSON.stringify({ format: "confirmed_plain_text", observation: content, feelings: [], needs: [], request: "" }));
    expect(store.getPerspective(result.eventId, "b")).toBeUndefined();
    expect(store.getMerged(result.eventId)).toBeUndefined();
    expect(store.getAgreement(result.eventId)).toBeUndefined();
    expect(store.getEvent(f.oldEventId)).toBeUndefined();
    expect(store.getMerged(f.oldEventId)).toBeUndefined();
    expect(store.getAgreement(f.oldEventId)).toBeUndefined();
    expect(unrelatedSnapshot(f)).toEqual(other);
  });

  it("第三人不能请求、确认或删除别人的共享事件与草稿，目标删除也不影响其他用户和事件", async () => {
    const f = await sharedFixture();
    const before = [privateSnapshot(f.aPrivate), privateSnapshot(f.bPrivate)];
    const other = unrelatedSnapshot(f);
    const deniedDelete = await request(f.outsider, `/events/${f.oldEventId}`, "DELETE");
    expect(deniedDelete.status).toBe(403);
    const deniedRequest = await request(f.outsider, `/events/${f.oldEventId}/deletion-request`);
    expect(deniedRequest.status).toBe(404);
    const deniedConfirm = await request(f.outsider, `/conversations/${f.bPrivate.conversationId}/share-drafts/${f.bDraft.id}/confirm`, "POST", { version: f.bDraft.version, invitePartner: true });
    expect(deniedConfirm.status).toBe(404);
    expect(store.db.prepare("SELECT * FROM event_deletion_requests WHERE event_id=?").all(f.oldEventId)).toEqual([]);
    expect([privateSnapshot(f.aPrivate), privateSnapshot(f.bPrivate)]).toEqual(before);
    await deleteTogether(f);
    expect(unrelatedSnapshot(f)).toEqual(other);
    expect(store.getUserById(f.a.id)).toBeTruthy();
    expect(store.getUserById(f.b.id)).toBeTruthy();
    expect(core.getActiveRiskMessages(f.outsider.id, f.bPrivate.conversationId)).toEqual([]);
    const foreignPrivate = await request(f.outsider, `/conversations/${f.bPrivate.conversationId}`, "GET");
    expect(foreignPrivate.status).toBe(404);
  });

  it("兼容旧版本留下的孤儿 converted 草稿：同版本确认不能返回已删除事件 ID", async () => {
    const f = await sharedFixture();
    emulateLegacyOrphan(f.oldEventId);
    for (const [privateState, draft] of [[f.aPrivate, f.aDraft], [f.bPrivate, f.bDraft]] as const) {
      expect(core.getShareDraft(privateState.actor.id, privateState.conversationId, draft.id)).toMatchObject({ status: "converted", version: draft.version, eventId: f.oldEventId });
      const response = await confirm(privateState, draft);
      expect.soft([404, 409]).toContain(response.status);
      expect.soft(await response.json()).not.toHaveProperty("eventId");
      expect.soft(core.confirmShareDraft(privateState.actor.id, privateState.conversationId, draft.id, draft.version)).toHaveProperty("error");
    }
    expect.soft(store.getEvent(f.oldEventId)).toBeUndefined();
  });

  it("兼容旧孤儿 B 关联：本人明确确认新草稿可创建新 waiting_b 事件", async () => {
    const f = await sharedFixture();
    emulateLegacyOrphan(f.oldEventId);
    expect(core.getOwnedConversation(f.b.id, f.bPrivate.conversationId)).toMatchObject({ linked_event_id: f.oldEventId, linked_side: "b" });
    const draft = await readyDraft(f.bPrivate, "旧孤儿关联后 B 本人新确认的合成内容");
    const response = await confirm(f.bPrivate, draft);
    expect(response.status).toBe(201);
    const result = await response.json() as { eventId: string };
    expect(result.eventId).not.toBe(f.oldEventId);
    expect(store.getEvent(result.eventId)).toMatchObject({ state: "waiting_b", a_user_id: f.b.id, b_user_id: null, partner_target_user_id: f.a.id });
    expect(core.getOwnedConversation(f.b.id, f.bPrivate.conversationId)).toMatchObject({ linked_event_id: result.eventId, linked_side: "a" });
    expect(store.getEvent(f.oldEventId)).toBeUndefined();
    expect(store.getMerged(result.eventId)).toBeUndefined();
    expect(store.getAgreement(result.eventId)).toBeUndefined();
  });
});
