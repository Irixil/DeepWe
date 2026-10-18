import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import api from "./routes";
import * as db from "./db";

function account(label: string) {
  const user = db.createUser(`${crypto.randomUUID()}@synthetic.test`, label, "synthetic-hash", "synthetic-salt");
  const token = crypto.randomBytes(32).toString("hex");
  db.createAccountSession(user.id, crypto.createHash("sha256").update(token).digest("hex"), Date.now() + 60_000);
  return { user, cookie: `dw_account=${token}` };
}

function request(path: string, method: string, cookie: string, body?: unknown) {
  return api.request(path, {
    method,
    headers: { "Content-Type": "application/json", Cookie: cookie },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function connect(a: ReturnType<typeof account>, b: ReturnType<typeof account>) {
  const invite = db.createPartnerInvite(a.user.id)!;
  expect(db.acceptPartnerInvite(invite.code, b.user.id)).toBe(true);
  expect(db.approvePartnerBindingRequest(a.user.id, invite.id)).toBe(true);
}

async function analytics(owner: ReturnType<typeof account>, eventId: string) {
  const notice = await request("/account/analytics-notice", "POST", owner.cookie);
  expect(notice.status).toBe(200);
  const response = await api.request("/analytics/events", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: owner.cookie, "x-deepwe-session": crypto.randomUUID() },
    body: JSON.stringify({ name: "screen_viewed", screen: "event", eventId }),
  });
  expect(response.status).toBe(200);
  expect((await response.json()).recorded).toBe(true);
}

function analyticsCount(eventId: string): number {
  return (db.db.prepare("SELECT COUNT(*) count FROM analytics_events WHERE event_id=?").get(eventId) as { count: number }).count;
}

const frontendAnalyticsSteps = [
  "couple", "records", "me", "story", "reflection", "checkin", "review",
  "a_expressing", "b_expressing", "ready_to_merge", "declined", "cancelled", "closed", "safety_exit", "sharing_revoked",
] as const;

function analyticsRequest(owner: ReturnType<typeof account>, body: Record<string, unknown>) {
  return api.request("/analytics/events", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: owner.cookie, "x-deepwe-session": crypto.randomUUID() },
    body: JSON.stringify(body),
  });
}

describe("前端固定体验步骤的真实 API 回归", () => {
  it.each(frontendAnalyticsSteps)("允许前端固定步骤 %s 的进入和离开事件", async step => {
    const owner = account(`固定步骤合成 ${step}`);
    expect((await request("/account/analytics-preference", "PATCH", owner.cookie, { enabled: true })).status).toBe(200);
    const isTab = ["couple", "records", "me"].includes(step);
    const event = db.createEvent("合成步骤记录", owner.user.id);
    const fields = { screen: isTab ? step : "event", step, ...(isTab ? {} : { eventId: event.id }) };
    for (const name of [isTab ? "screen_viewed" : "guide_stage_viewed", "screen_left"]) {
      const response = await analyticsRequest(owner, { name, ...fields });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ recorded: true });
    }
    expect((db.db.prepare("SELECT COUNT(*) count FROM analytics_events WHERE user_id=?").get(owner.user.id) as { count: number }).count).toBe(2);
  });

  it("未知步骤和自由文本仍返回 400，且不写统计", async () => {
    const owner = account("未知步骤合成");
    await request("/account/analytics-preference", "PATCH", owner.cookie, { enabled: true });
    for (const step of ["unknown_stage", "我们刚刚争执的私密原话", "couple-extra"]) {
      const response = await analyticsRequest(owner, { name: "screen_viewed", screen: "event", step });
      expect(response.status).toBe(400);
    }
    expect((db.db.prepare("SELECT COUNT(*) count FROM analytics_events WHERE user_id=?").get(owner.user.id) as { count: number }).count).toBe(0);
  });

  it("未同意体验统计时合法步骤返回 recorded false，仍不新增记录", async () => {
    const owner = account("拒绝统计合成");
    const preference = await request("/account/analytics-preference", "PATCH", owner.cookie, { enabled: false });
    expect(preference.status).toBe(200);
    const event = db.createEvent("合成拒绝统计记录", owner.user.id);
    for (const step of frontendAnalyticsSteps) {
      const isTab = ["couple", "records", "me"].includes(step);
      const response = await analyticsRequest(owner, { name: isTab ? "screen_viewed" : "guide_stage_viewed", screen: isTab ? step : "event", step, ...(isTab ? {} : { eventId: event.id }) });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ recorded: false });
    }
    const outcome = await analyticsRequest(owner, { name: "core_outcome_submitted", screen: "event", step: "closed", eventId: event.id, result: "skipped" });
    expect(outcome.status).toBe(200);
    expect(await outcome.json()).toEqual({ recorded: false });
    expect((db.db.prepare("SELECT COUNT(*) count FROM analytics_events WHERE user_id=?").get(owner.user.id) as { count: number }).count).toBe(0);
  });
});

describe("确认、删除和危险退出的真实 API 回归", () => {
  it("共同提案只允许确认本人看见的版本，拒绝缺省、陈旧与越权请求", async () => {
    const a = account("合成伴侣 A"), b = account("合成伴侣 B"), outsider = account("合成访客");
    connect(a, b);
    const created = await request("/partner/space/proposals", "POST", a.cookie, { category: "communication_method", content: "先听完，再回应" });
    expect(created.status).toBe(201);
    const original = (await created.json()).proposal;
    const bView = await request("/partner/space", "GET", b.cookie);
    const seen = (await bView.json()).space.proposals[0];
    const revised = await request(`/partner/space/proposals/${original.id}`, "PATCH", a.cookie, { content: "先暂停十分钟，再回来谈" });
    expect(revised.status).toBe(200);
    const current = (await revised.json()).space.proposals[0];
    const stale = await request(`/partner/space/proposals/${original.id}/confirm`, "POST", b.cookie, { expectedVersion: seen.version ?? 1 });
    expect(stale.status).toBe(409);
    expect(seen.version).toBe(1);
    expect(current).toEqual(expect.objectContaining({ version: 2, myConfirmed: true, partnerConfirmed: false }));
    const missing = await request(`/partner/space/proposals/${original.id}/confirm`, "POST", b.cookie);
    expect(missing.status).toBe(400);
    expect(db.listSharedMemoriesForUser(b.user.id)).toEqual([]);
    const unauthorized = await request(`/partner/space/proposals/${original.id}/confirm`, "POST", outsider.cookie, { expectedVersion: current.version });
    expect(unauthorized.status).toBe(409);
    const confirmed = await request(`/partner/space/proposals/${original.id}/confirm`, "POST", b.cookie, { expectedVersion: current.version });
    expect(confirmed.status).toBe(200);
    expect((await confirmed.json()).space.memories[0].content).toBe(current.content);
    expect((await request(`/partner/space/proposals/${original.id}/confirm`, "POST", b.cookie, { expectedVersion: current.version })).status).toBe(409);
  });

  it("永久删除单人事件时清除双方关联体验事件并保留其他事件和用户", async () => {
    const a = account("单人删除合成 A"), other = account("单人删除合成其他用户");
    const deleted = db.createEvent("合成待删除记录", a.user.id), kept = db.createEvent("合成保留记录", a.user.id), otherEvent = db.createEvent("合成他人记录", other.user.id);
    await analytics(a, deleted.id); await analytics(a, kept.id); await analytics(other, otherEvent.id);
    const response = await request(`/events/${deleted.id}`, "DELETE", a.cookie);
    expect(response.status).toBe(200);
    expect((await response.json()).hiddenOnly).toBe(false);
    expect(analyticsCount(deleted.id)).toBe(0);
    expect(analyticsCount(kept.id)).toBe(1);
    expect(analyticsCount(otherEvent.id)).toBe(1);
  });

  it("共同事件隐藏和首个删除确认不清数据，双方永久删除后清双方体验事件", async () => {
    const a = account("共同删除合成 A"), b = account("共同删除合成 B");
    const event = db.createEvent("合成共同记录", a.user.id), kept = db.createEvent("合成保留 B 记录", b.user.id);
    db.transition(event.id, "a_guiding", "a_summary"); db.transition(event.id, "a_summary", "waiting_b");
    expect(db.setBParticipant(event.id, db.randomToken(), b.user.id)).toBe(true);
    await analytics(a, event.id); await analytics(b, event.id); await analytics(b, kept.id);
    expect((await request(`/events/${event.id}`, "DELETE", b.cookie)).status).toBe(200);
    expect(analyticsCount(event.id)).toBe(2);
    const pending = await request(`/events/${event.id}/deletion-request`, "POST", a.cookie);
    expect((await pending.json()).status).toBe("pending");
    expect(analyticsCount(event.id)).toBe(2);
    const deleted = await request(`/events/${event.id}/deletion-request`, "POST", b.cookie);
    expect((await deleted.json()).status).toBe("deleted");
    expect(analyticsCount(event.id)).toBe(0);
    expect(analyticsCount(kept.id)).toBe(1);
  });

  it("危险转折使正在处理的旧普通回复失效，晚到写回不能再保存普通建议", async () => {
    const a = account("危险转折合成 A"), event = db.createEvent("合成危险转折", a.user.id);
    const source = db.addGuideMessage(event.id, "a", "a", "我们为了家务争执，我想学着沟通");
    const queued = db.enqueueAiJob(event.id, "guide", "a", source);
    const job = db.claimNextAiJob()!;
    expect(job.id).toBe(queued.id);
    const response = await request(`/events/${event.id}/guide`, "POST", a.cookie, { message: "但现在他正在掐脖子，不让我离开" });
    expect(response.status).toBe(200);
    expect(db.getEvent(event.id)?.state).toBe("safety_exit");
    db.completeGuideAiJob(job, "回去和伴侣继续沟通家务", "story", JSON.stringify({ context: "旧任务普通讨论" }));
    expect(db.getGuideMessages(event.id, "a").filter(message => message.role === "ai")).toEqual([]);
    expect(db.getGuideSession(event.id, "a")).toBeUndefined();
    expect(db.getAiJob(job.id)?.status).toBe("cancelled");
  });

  it("即使旧任务未主动取消，写回仍再次检查当前状态和风险", () => {
    for (const blockedBy of ["state", "risk"] as const) {
      const a = account(`写回防线合成 ${blockedBy}`), event = db.createEvent("合成未取消旧任务", a.user.id);
      const source = db.addGuideMessage(event.id, "a", "a", "我们因为约会时间有分歧");
      db.enqueueAiJob(event.id, "guide", "a", source);
      const job = db.claimNextAiJob()!;
      if (blockedBy === "state") expect(db.transition(event.id, "a_guiding", "safety_exit")).toBe(true);
      else db.db.prepare("UPDATE events SET risk_level='violence' WHERE id=?").run(event.id);
      expect(db.getAiJob(job.id)?.status).toBe("processing");
      expect(db.aiJobInputsAreAllowed(job)).toBe(false);
      db.completeGuideAiJob(job, "旧普通建议不得保存", "story", "{}");
      expect(db.getGuideMessages(event.id, "a")).toHaveLength(1);
      expect(db.getAiJob(job.id)?.status).toBe("cancelled");
    }
  });

  it("B 私密危险表达的类别仅发本人，A 和无权限访客不得获得类别或原话", async () => {
    const a = account("风险隐私合成 A"), b = account("风险隐私合成 B"), outsider = account("风险隐私合成访客");
    const event = db.createEvent("合成私密危险类别", a.user.id);
    db.transition(event.id, "a_guiding", "a_summary"); db.transition(event.id, "a_summary", "waiting_b");
    expect(db.setBParticipant(event.id, db.randomToken(), b.user.id)).toBe(true);
    db.transition(event.id, "waiting_b", "b_guiding");
    const privateText = "我现在打算自杀，这是只属于 B 的合成内容";
    expect((await request(`/events/${event.id}/guide`, "POST", b.cookie, { message: privateText })).status).toBe(200);
    const aResponse = await request(`/events/${event.id}`, "GET", a.cookie);
    const aBody = await aResponse.json();
    expect(aBody).toEqual(expect.objectContaining({ state: "safety_exit", risk: "private_safety" }));
    expect(JSON.stringify(aBody)).not.toContain("self_harm");
    expect(JSON.stringify(aBody)).not.toContain(privateText);
    const bResponse = await request(`/events/${event.id}`, "GET", b.cookie);
    expect((await bResponse.json()).risk).toBe("self_harm");
    expect((await request(`/events/${event.id}`, "GET", outsider.cookie)).status).toBe(404);
  });

  it("旧记录没有可信风险来源时，对双方只返回通用停止状态", async () => {
    const a = account("旧风险隐私合成 A"), b = account("旧风险隐私合成 B");
    const event = db.createEvent("合成旧风险记录", a.user.id);
    db.db.prepare("UPDATE events SET b_user_id=?,risk_level='violence',state='safety_exit' WHERE id=?").run(b.user.id, event.id);
    for (const participant of [a, b]) {
      const response = await request(`/events/${event.id}`, "GET", participant.cookie);
      expect((await response.json()).risk).toBe("private_safety");
    }
  });

  it("账号导出遵守共同理解的本人定向内容边界，并保留确实共享的内容", async () => {
    const a = account("导出隐私合成 A"), b = account("导出隐私合成 B"), event = db.createEvent("合成共同导出", a.user.id);
    db.db.prepare("UPDATE events SET b_user_id=?,state='merged' WHERE id=?").run(b.user.id, event.id);
    const content = {
      event_summary: "双方可以看到的合成经过", shared_facts: ["双方可以看到的合成事实"],
      a_view: { feelings: ["A 的已确认感受"], needs: [], request: "" }, b_view: { feelings: ["B 的已确认感受"], needs: [], request: "" },
      different_views: [], unresolved: [], repair_phrases: { a: "A 的公开表达", b: "B 的公开表达" },
      a_suggestions: ["只有 A 可看的定向建议"], a_partner_view: "只有 A 可看的定向视角", a_actions: ["只有 A 可看的行动候选"],
      b_suggestions: ["只有 B 可看的定向建议"], b_partner_view: "只有 B 可看的定向视角", b_actions: ["只有 B 可看的行动候选"],
    };
    db.upsertMerged(event.id, JSON.stringify(content));
    for (const [owner, side, other] of [[a, "a", "b"], [b, "b", "a"]] as const) {
      const response = await request("/account/export", "GET", owner.cookie);
      expect(response.status).toBe(200);
      const understanding = (await response.json()).data.conversations.find((item: { id: string }) => item.id === event.id).sharedUnderstanding;
      expect(understanding).not.toHaveProperty(`${other}_suggestions`);
      expect(understanding).not.toHaveProperty(`${other}_partner_view`);
      expect(understanding).not.toHaveProperty(`${other}_actions`);
      expect(understanding[`${side}_suggestions`]).toEqual(content[`${side}_suggestions`]);
      expect(understanding.event_summary).toBe(content.event_summary);
      expect(understanding.shared_facts).toEqual(content.shared_facts);
      expect(understanding.a_view).toEqual(content.a_view);
      expect(understanding.b_view).toEqual(content.b_view);
    }
    expect((await api.request("/account/export")).status).toBe(401);
  });
});
