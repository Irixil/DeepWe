import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import api from "./routes";
import * as db from "./db";
import * as privateCore from "./private-core";
import { emptyStoryMap, type MergedUnderstanding, type NvcSummary, type StoryMap } from "./ai";

const originalKey = process.env.DEEPSEEK_API_KEY;
const originalRouterEnabled = process.env.DEEPWE_ROUTER_ENABLED;

beforeEach(() => {
  process.env.DEEPWE_ROUTER_ENABLED = "false";
  delete process.env.DEEPWE_OWNER_USER_ID;
});

afterEach(() => {
  if (originalKey === undefined) delete process.env.DEEPSEEK_API_KEY;
  else process.env.DEEPSEEK_API_KEY = originalKey;
  if (originalRouterEnabled === undefined) delete process.env.DEEPWE_ROUTER_ENABLED;
  else process.env.DEEPWE_ROUTER_ENABLED = originalRouterEnabled;
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const summaryA: NvcSummary = {
  observation: "A 观察到约定临时变化",
  feelings: ["失落"],
  needs: ["提前沟通"],
  request: "希望变动时提前告知",
};

const summaryB: NvcSummary = {
  observation: "B 临时需要处理家事",
  feelings: ["内疚"],
  needs: ["被理解"],
  request: "希望先说明当时的情况",
};

const merged: MergedUnderstanding = {
  event_summary: "双方对一次临时变动有不同感受。",
  shared_facts: ["原定安排发生了变化"],
  a_view: { feelings: summaryA.feelings, needs: summaryA.needs, request: summaryA.request },
  b_view: { feelings: summaryB.feelings, needs: summaryB.needs, request: summaryB.request },
  different_views: ["双方对告知是否及时理解不同"],
  unresolved: [],
  repair_phrases: { a: "A 的表达", b: "B 的表达" },
  a_suggestions: ["给 A 的建议"],
  a_partner_view: "只给 A 的伴侣视角",
  a_actions: ["A 的行动"],
  b_suggestions: ["给 B 的建议"],
  b_partner_view: "只给 B 的伴侣视角",
  b_actions: ["B 的行动"],
};

function cookie(id: string, token: string): string {
  return "dw_" + id + "=" + token;
}

let testAccountSequence = 0;
let routeAdminCookie = "";
let routeAdminOwnerId = "";

describe("实验版身份", () => {
  it("健康检查明确标记独立专业实验后端", async () => {
    const response = await api.request("/health");
    expect(await response.json()).toEqual({
      ok: true,
      version: "professional-v2-experiment",
      humanReviewed: false,
      ownerConfigured: false,
    });
  });

  it("潜谈创建请求编号幂等、按账号隔离，删除后不复活，旧调用仍可用", async () => {
    const firstAccount=await createTestAccount(),secondAccount=await createTestAccount(),clientRequestId=`create-${db.randomToken()}`;
    const send=async(cookie:string,title:string,withKey=true)=>api.request("/conversations",{
      method:"POST",headers:{"Content-Type":"application/json",Cookie:cookie},
      body:JSON.stringify({title,...(withKey?{clientRequestId}:{})}),
    });
    const created=await send(firstAccount.cookie,"首个标题");
    expect(created.status).toBe(201);
    const createdBody=await created.json() as {conversation:{id:string;title:string}};
    const retried=await send(firstAccount.cookie,"重试时不同的标题");
    expect(retried.status).toBe(200);
    expect(await retried.json()).toEqual({conversation:createdBody.conversation});

    const otherOwner=await send(secondAccount.cookie,"另一账号会话");
    expect(otherOwner.status).toBe(201);
    expect((await otherOwner.json()).conversation.id).not.toBe(createdBody.conversation.id);

    const deleted=await api.request(`/conversations/${createdBody.conversation.id}`,{method:"DELETE",headers:{Cookie:firstAccount.cookie}});
    expect(deleted.status).toBe(204);
    const afterDelete=await send(firstAccount.cookie,"不能复活");
    expect(afterDelete.status).toBe(409);
    expect((await afterDelete.json()).code).toBe("IDEMPOTENCY_KEY_RETIRED");
    expect((await api.request(`/conversations/${createdBody.conversation.id}`,{headers:{Cookie:firstAccount.cookie}})).status).toBe(404);

    const legacyOne=await send(firstAccount.cookie,"兼容旧调用",false),legacyTwo=await send(firstAccount.cookie,"兼容旧调用",false);
    expect(legacyOne.status).toBe(201);
    expect(legacyTwo.status).toBe(201);
    expect((await legacyOne.json()).conversation.id).not.toBe((await legacyTwo.json()).conversation.id);

    const columns=db.db.pragma(`table_info(private_conversations)`) as Array<{name:string}>;
    expect(columns.some(column=>column.name==="client_request_id")).toBe(true);
    const indexes=db.db.pragma(`index_list(private_conversations)`) as Array<{name:string;unique:number}>;
    expect(indexes).toEqual(expect.arrayContaining([expect.objectContaining({name:"private_conversations_idempotency_idx",unique:1})]));
  });

  it("非对象、null 和畸形 JSON 写入体统一返回 400，无正文的动作请求仍进入鉴权", async () => {
    for(const body of ["null","[]","{"]) {
      const response=await api.request("/auth/login",{method:"POST",headers:{"Content-Type":"application/json"},body});
      expect(response.status).toBe(400);
      expect(response.headers.get("Cache-Control")).toContain("no-store");
      expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    }
    const wrongType=await api.request("/auth/login",{method:"POST",headers:{"Content-Type":"text/plain"},body:"{}"});
    expect(wrongType.status).toBe(415);
    expect(wrongType.headers.get("Cache-Control")).toContain("no-store");
    const crossSite=await api.request("/auth/login",{method:"POST",headers:{"Content-Type":"application/json",Origin:"https://evil.example"},body:"null"});
    expect(crossSite.status).toBe(403);
    expect(crossSite.headers.get("Cache-Control")).toContain("no-store");
    const conversation=await api.request("/conversations",{method:"POST",headers:{"Content-Type":"application/json"},body:"{\"title\":\"ok\"}"});
    expect(conversation.status).toBe(401);
    const noBody=await api.request("/conversations/c/jobs/j/cancel",{method:"POST"});
    expect(noBody.status).toBe(401);
  });
});

async function ensureRouteAdmin(): Promise<void> {
  if (routeAdminCookie) {
    vi.stubEnv("DEEPWE_OWNER_USER_ID", routeAdminOwnerId);
    return;
  }
  const response = await api.request("/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      displayName: "接口测试管理员",
      email: "routes-admin@deepwe.test",
      password: "routes-admin-password",
    }),
  });
  expect(response.status).toBe(201);
  const registered = await response.clone().json();
  routeAdminOwnerId = registered.user.id;
  vi.stubEnv("DEEPWE_OWNER_USER_ID", routeAdminOwnerId);
  routeAdminCookie = String(response.headers.get("set-cookie")).split(";")[0];
}

describe("注册邀请开关", () => {
  it("关闭时允许无邀请码注册，重新开启后恢复拦截", async () => {
    await ensureRouteAdmin();
    vi.stubEnv("DEEPWE_REGISTRATION_INVITE_REQUIRED", "false");

    const status = await api.request("/auth/registration-status");
    expect(await status.json()).toEqual({ inviteRequired: false });
    testAccountSequence += 1;
    const openRegistration = await api.request("/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        displayName: "开放注册测试用户",
        email: `open-${testAccountSequence}@deepwe.test`,
        password: "safe-password-123",
      }),
    });
    expect(openRegistration.status).toBe(201);

    vi.stubEnv("DEEPWE_REGISTRATION_INVITE_REQUIRED", "true");
    testAccountSequence += 1;
    const gatedRegistration = await api.request("/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        displayName: "邀请制测试用户",
        email: `gated-${testAccountSequence}@deepwe.test`,
        password: "safe-password-123",
      }),
    });
    expect(gatedRegistration.status).toBe(403);
    expect((await gatedRegistration.json()).error).toBe("请输入邀请码");
  });
});

async function createAccountCookie(): Promise<string> {
  await ensureRouteAdmin();
  testAccountSequence += 1;
  const inviteResponse = await api.request("/admin/registration-invites", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: routeAdminCookie },
    body: JSON.stringify({ note: "安全测试邀请" }),
  });
  expect(inviteResponse.status).toBe(201);
  const registrationCode = (await inviteResponse.json()).invite.code;
  const response = await api.request("/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      displayName: "安全测试用户",
      email: `safety-${testAccountSequence}@deepwe.test`,
      password: "safe-password-123",
      registrationCode,
    }),
  });
  expect(response.status).toBe(201);
  return String(response.headers.get("set-cookie")).split(";")[0];
}

async function createTestAccount(): Promise<{ cookie: string; userId: string }> {
  const cookie = await createAccountCookie();
  const user = db.getUserByEmail(`safety-${testAccountSequence}@deepwe.test`)!;
  return { cookie, userId: user.id };
}

describe("唯一所有者注销保护", () => {
  it("按服务端 owner ID 阻止所有者自删，遗留管理员标记不阻止普通注销", async () => {
    await ensureRouteAdmin();
    const ownerDelete = await api.request("/account", {
      method: "DELETE",
      headers: { "Content-Type": "application/json", Cookie: routeAdminCookie },
      body: JSON.stringify({ password: "routes-admin-password" }),
    });
    expect(ownerDelete.status).toBe(409);
    expect(db.getUserById(routeAdminOwnerId)).toBeTruthy();

    const legacyAdmin = db.createUser(`legacy-${Date.now()}@deepwe.test`, "遗留管理员标记", "hash", "salt", true);
    expect(db.deleteUserPrivateData(legacyAdmin.id)).toBe(true);
    expect(db.getUserById(legacyAdmin.id)).toBeUndefined();
  });
});

function createMergedFixture() {
  const event = db.createEvent("原始标题可能带有情绪");
  const bToken = db.randomToken();
  db.setBTokens(event.id, bToken);
  db.upsertPerspective(event.id, "a", "A 私密原文");
  db.upsertPerspective(event.id, "b", "B 私密原文");
  db.setSummary(event.id, "a", JSON.stringify(summaryA));
  db.setSummary(event.id, "b", JSON.stringify(summaryB));
  db.confirmSummary(event.id, "a");
  db.confirmSummary(event.id, "b");
  db.transition(event.id, "a_guiding", "a_summary");
  db.transition(event.id, "a_summary", "waiting_b");
  db.transition(event.id, "waiting_b", "b_guiding");
  db.transition(event.id, "b_guiding", "b_summary");
  db.upsertMerged(event.id, JSON.stringify(merged));
  db.transition(event.id, "b_summary", "merged");
  return { event, bToken };
}

async function createBoundEventFixture(state: "a_summary" | "waiting_b" | "b_guiding" | "b_summary" | "merged" | "agreement_proposed" | "done" | "sharing_revoked" = "merged") {
  const a = await createTestAccount();
  const b = await createTestAccount();
  const event = db.createEvent("合成绑定风险事件", a.userId);
  db.db.prepare(`UPDATE events SET state='waiting_b' WHERE id=?`).run(event.id);
  const bToken = db.randomToken();
  if (!db.setBParticipant(event.id, bToken, b.userId)) throw new Error("合成 B 账号绑定失败");
  db.db.prepare(`UPDATE events SET state=? WHERE id=?`).run(state, event.id);
  db.upsertPerspective(event.id, "a", "合成私密来源");
  db.upsertPerspective(event.id, "b", "合成私密来源");
  db.setSummary(event.id, "a", JSON.stringify(summaryA));
  db.setSummary(event.id, "b", JSON.stringify(summaryB));
  db.confirmSummary(event.id, "a");
  if (["merged", "agreement_proposed", "done", "sharing_revoked"].includes(state)) {
    db.confirmSummary(event.id, "b");
    db.upsertMerged(event.id, JSON.stringify(merged));
  }
  if (["agreement_proposed", "done"].includes(state)) {
    db.setChoice(event.id, "a", "A 合成行动");
    if (state === "done") {
      db.setChoice(event.id, "b", "B 合成行动");
      db.markAgreementDone(event.id);
    }
  }
  const aConversation = privateCore.createConversation(a.userId, "A 合成私密会话", { eventId: event.id, side: "a" });
  const bConversation = privateCore.createConversation(b.userId, "B 合成私密会话", { eventId: event.id, side: "b" });
  return { event, a, b, bToken, aConversation, bConversation };
}

function setSyntheticActiveRisk(conversationId: string): void {
  db.db.prepare(`INSERT INTO private_risk_state(conversation_id,situation,source_message_ids,updated_at) VALUES(?,?,?,?)`)
    .run(conversationId, "synthetic-risk-marker", "[]", Date.now());
}


async function getEvent(id: string, token?: string) {
  const response = await api.request("/events/" + id, {
    headers: token ? { Cookie: cookie(id, token) } : undefined,
  });
  return { response, body: await response.json() };
}

describe("事件读取的数据最小化", () => {
  it("A 和 B 只能收到属于本人的定向内容", async () => {
    const { event, bToken } = createMergedFixture();

    const a = await getEvent(event.id, event.aToken);
    expect(a.response.status).toBe(200);
    expect(a.body.mergedVersion).toBe(1);
    expect(a.body.merged.a_suggestions).toEqual(["给 A 的建议"]);
    expect(a.body.merged).not.toHaveProperty("b_suggestions");
    expect(a.body.merged).not.toHaveProperty("b_partner_view");
    expect(a.body.merged).not.toHaveProperty("b_actions");

    const b = await getEvent(event.id, bToken);
    expect(b.body.merged.b_suggestions).toEqual(["给 B 的建议"]);
    expect(b.body.merged).not.toHaveProperty("a_suggestions");
    expect(b.body.merged).not.toHaveProperty("a_partner_view");
    expect(b.body.merged).not.toHaveProperty("a_actions");
  });

  it("访客不能读取对话的存在性、状态和风险", async () => {
    const { event } = createMergedFixture();
    const guest = await getEvent(event.id);

    expect(guest.response.status).toBe(404);
    expect(Object.keys(guest.body)).toEqual(["error"]);
    const missing = await getEvent("00000000-0000-4000-8000-000000000000");
    expect(missing.body).toEqual(guest.body);
  });

  it("无权限写操作返回 403 且不改变状态", async () => {
    const { event } = createMergedFixture();
    const response = await api.request("/events/" + event.id + "/merged/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });

    expect(response.status).toBe(403);
    expect(db.getEvent(event.id)?.state).toBe("merged");
  });

  it("共同理解只接受当前版本，双方确认后才进入共同行动", async () => {
    const { event, bToken } = createMergedFixture();
    const version = db.getMerged(event.id)!.version;
    const stale = await api.request(`/events/${event.id}/merged/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie(event.id, event.aToken) },
      body: JSON.stringify({ expectedVersion: version - 1 }),
    });
    expect(stale.status).toBe(409);
    expect((await stale.json()).stale).toBe(true);
    expect(db.getMerged(event.id)?.a_confirmed).toBe(0);

    const confirmA = await api.request(`/events/${event.id}/merged/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie(event.id, event.aToken) },
      body: JSON.stringify({ expectedVersion: version }),
    });
    expect(confirmA.status).toBe(200);
    const confirmB = await api.request(`/events/${event.id}/merged/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie(event.id, bToken) },
      body: JSON.stringify({ expectedVersion: version }),
    });
    expect(confirmB.status).toBe(200);
    expect((await confirmB.json()).bothConfirmed).toBe(true);
    expect(db.getEvent(event.id)?.state).toBe("agreement_proposed");
  });

  it("B 纠偏受理后双方接口立即隐藏旧报告与确认位，失败或未知时也不恢复", async () => {
    const { event, bToken } = createMergedFixture();
    const oldContent = db.getMerged(event.id)!.content;
    const oldVersion = db.getMerged(event.id)!.version;
    db.confirmMerged(event.id, "a", oldVersion);
    const workerState = globalThis as unknown as { __deepweAiWorkerRunning?: boolean };
    const wasRunning = workerState.__deepweAiWorkerRunning;
    workerState.__deepweAiWorkerRunning = true;
    try {
      const accepted = await api.request(`/events/${event.id}/merged/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie(event.id, bToken) },
        body: JSON.stringify({ expectedVersion: oldVersion, correction: "只修正 B 对当时情况的描述。" }),
      });
      expect(accepted.status).toBe(202);
      const queued = db.getVisibleAiJob(event.id, "a")!;
      expect(queued).toMatchObject({ kind: "merge_correction", status: "queued" });
      expect(db.getMerged(event.id)).toMatchObject({ content: oldContent, a_confirmed: 0, b_confirmed: 0 });

      for (const token of [event.aToken, bToken]) {
        const pending = await getEvent(event.id, token);
        expect(pending.response.status).toBe(200);
        expect(pending.body.merged).toBeNull();
        expect(pending.body.mergedVersion).toBeNull();
        expect(pending.body.mergedAConfirmed).toBe(false);
        expect(pending.body.mergedBConfirmed).toBe(false);
        expect(pending.body.aiJobKind).toBe("merge_correction");
        expect(pending.body.aiJobStatus).toBe("queued");
      }

      for (const errorCode of [null, "AI_RESULT_UNKNOWN"]) {
        db.db.prepare(`UPDATE ai_jobs SET status='failed',error='合成失败',error_code=? WHERE id=?`).run(errorCode, queued.id);
        for (const token of [event.aToken, bToken]) {
          const failed = await getEvent(event.id, token);
          expect(failed.body.merged).toBeNull();
          expect(failed.body.mergedVersion).toBeNull();
          expect(failed.body.mergedAConfirmed).toBe(false);
          expect(failed.body.mergedBConfirmed).toBe(false);
          expect(failed.body.aiJobStatus).toBe("failed");
        }
      }
      const confirmOld = await api.request(`/events/${event.id}/merged/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie(event.id, event.aToken) },
        body: JSON.stringify({ expectedVersion: oldVersion }),
      });
      expect(confirmOld.status).toBe(409);
      expect(db.getEvent(event.id)?.state).toBe("merged");
      expect(db.getMerged(event.id)).toMatchObject({ content: oldContent, version: oldVersion, a_confirmed: 0, b_confirmed: 0 });

      db.db.prepare(`UPDATE ai_jobs SET error_code=NULL WHERE id=?`).run(queued.id);
      expect(db.retryVisibleAiJob(event.id, "b", queued.id, queued.attempts)).toBe(true);
      const retry = db.claimNextAiJob()!;
      db.completeMergeAiJob(retry, JSON.stringify(merged));
      const regenerated = await getEvent(event.id, event.aToken);
      expect(regenerated.body.mergedVersion).toBe(oldVersion + 1);
      expect(regenerated.body.merged).not.toBeNull();
      expect(regenerated.body.mergedAConfirmed).toBe(false);
      expect(regenerated.body.mergedBConfirmed).toBe(false);

      const confirmA = await api.request(`/events/${event.id}/merged/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie(event.id, event.aToken) },
        body: JSON.stringify({ expectedVersion: oldVersion + 1 }),
      });
      expect(confirmA.status).toBe(200);
      const confirmB = await api.request(`/events/${event.id}/merged/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie(event.id, bToken) },
        body: JSON.stringify({ expectedVersion: oldVersion + 1 }),
      });
      expect(confirmB.status).toBe(200);
      expect((await confirmB.json()).bothConfirmed).toBe(true);
      expect(db.getEvent(event.id)?.state).toBe("agreement_proposed");
    } finally {
      if (wasRunning === undefined) delete workerState.__deepweAiWorkerRunning;
      else workerState.__deepweAiWorkerRunning = wasRunning;
    }
  });

  it("纠偏入队失败时回滚纠偏和确认位，向用户返回可理解错误", async () => {
    const { event, bToken } = createMergedFixture();
    const oldVersion = db.getMerged(event.id)!.version;
    db.confirmMerged(event.id, "a", oldVersion);
    const workerState = globalThis as unknown as { __deepweAiWorkerRunning?: boolean };
    const wasRunning = workerState.__deepweAiWorkerRunning;
    workerState.__deepweAiWorkerRunning = true;
    db.db.exec(`CREATE TRIGGER fail_merge_correction_insert
      BEFORE INSERT ON ai_jobs WHEN NEW.kind='merge_correction'
      BEGIN SELECT RAISE(ABORT, 'synthetic queue failure'); END`);
    try {
      const response = await api.request(`/events/${event.id}/merged/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie(event.id, bToken) },
        body: JSON.stringify({ expectedVersion: oldVersion, correction: "只修正 B 对当时情况的描述。" }),
      });
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        bothConfirmed: false,
        regenerated: false,
        queued: false,
        error: "纠偏未能保存并排队，请稍后重试",
      });
      expect(db.getPerspective(event.id, "b")?.correction).toBeNull();
      expect(db.getMerged(event.id)).toMatchObject({ content: expect.any(String), a_confirmed: 1, b_confirmed: 0 });
      expect(db.getVisibleAiJob(event.id, "a")).toBeUndefined();
      expect(db.getVisibleAiJob(event.id, "b")).toBeUndefined();
    } finally {
      db.db.exec("DROP TRIGGER IF EXISTS fail_merge_correction_insert");
      workerState.__deepweAiWorkerRunning = wasRunning;
    }
  });

  it("摘要即使重新确认，旧输入快照的晚到合并结果也不能写回", () => {
    const { event } = createMergedFixture();
    const job = db.enqueueAiJob(event.id, "merge_correction", "a");
    db.db.prepare(`UPDATE ai_jobs SET status='processing' WHERE id=?`).run(job.id);
    db.setSummary(event.id, "a", JSON.stringify({ ...summaryA, observation: "已修订的新摘要" }));
    db.confirmSummary(event.id, "a");
    db.completeMergeAiJob(job, JSON.stringify({ ...merged, event_summary: "过期合并" }));
    expect(db.getAiJob(job.id)?.status).toBe("cancelled");
    expect(JSON.parse(db.getMerged(event.id)!.content!).event_summary).toBe(merged.event_summary);
  });
});

describe("旧共同理解显式恢复", () => {
  function prepareLegacyRecovery() {
    const fixture = createMergedFixture();
    db.setCorrection(fixture.event.id, "a", "请按双方已确认的摘要重新整理。");
    return fixture;
  }

  async function recover(eventId: string, token: string, expectedVersion: number, accountCookie?: string) {
    return api.request(`/events/${eventId}/merged/recover`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: [accountCookie, cookie(eventId, token)].filter(Boolean).join("; ") },
      body: JSON.stringify({ expectedVersion }),
    });
  }

  it("双方可见恢复状态，访客不能读取或触发恢复", async () => {
    const { event, bToken } = prepareLegacyRecovery();
    for (const token of [event.aToken, bToken]) {
      const detail = await getEvent(event.id, token);
      expect(detail.body.mergedRecovery).toEqual({ kind: "available", expectedVersion: 1, reason: "旧生成依据无法核验，可基于当前已确认内容重新生成" });
    }
    expect((await getEvent(event.id)).response.status).toBe(404);
    expect((await recover(event.id, "", 1)).status).toBe(403);
    expect(db.getVisibleAiJob(event.id, "a")).toBeUndefined();
  });

  it("只有显式请求入队；完成后产生新版本并要求双方重新确认", async () => {
    const { event, bToken } = prepareLegacyRecovery();
    const workerState = globalThis as unknown as { __deepweAiWorkerRunning?: boolean };
    const wasRunning = workerState.__deepweAiWorkerRunning;
    workerState.__deepweAiWorkerRunning = true;
    try {
      const detail = await getEvent(event.id, event.aToken);
      const attempts = await Promise.all([
        recover(event.id, event.aToken, detail.body.mergedRecovery.expectedVersion),
        recover(event.id, bToken, detail.body.mergedRecovery.expectedVersion),
      ]);
      expect(attempts.map((response) => response.status).sort()).toEqual([202, 409]);
      const job = db.getVisibleAiJob(event.id, "a")!;
      expect(job).toMatchObject({ kind: "merge_correction", status: "queued", source_snapshot: expect.any(String) });
      expect(db.getMerged(event.id)).toMatchObject({ a_confirmed: 0, b_confirmed: 0 });
      expect(db.db.prepare(`SELECT COUNT(*) count FROM ai_jobs WHERE event_id=? AND kind='merge_correction'`).get(event.id)).toMatchObject({ count: 1 });

      db.completeMergeAiJob(db.claimNextAiJob()!, JSON.stringify(merged));
      expect(db.getMerged(event.id)?.version).toBe(2);
      for (const token of [event.aToken, bToken]) {
        const updated = await getEvent(event.id, token);
        expect(updated.body.mergedVersion).toBe(2);
        expect(updated.body.mergedRecovery).toBeNull();
        const confirmation = await api.request(`/events/${event.id}/merged/confirm`, {
          method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie(event.id, token) },
          body: JSON.stringify({ expectedVersion: 2 }),
        });
        expect(confirmation.status).toBe(200);
      }
      expect(db.getMerged(event.id)).toMatchObject({ a_confirmed: 1, b_confirmed: 1 });
      expect(db.getEvent(event.id)?.state).toBe("agreement_proposed");
    } finally {
      if (wasRunning === undefined) delete workerState.__deepweAiWorkerRunning;
      else workerState.__deepweAiWorkerRunning = wasRunning;
    }
  });

  it("旧 completed 和缺来源 failed 保留历史；缺来源 failed 作废后重新排队", async () => {
    const completed = prepareLegacyRecovery();
    const oldCompleted = db.enqueueAiJob(completed.event.id, "merge_correction", "a");
    db.db.prepare(`UPDATE ai_jobs SET status='completed',source_snapshot=NULL WHERE id=?`).run(oldCompleted.id);
    expect((await getEvent(completed.event.id, completed.event.aToken)).body.mergedRecovery.kind).toBe("available");
    const wasRunning = (globalThis as unknown as { __deepweAiWorkerRunning?: boolean }).__deepweAiWorkerRunning;
    (globalThis as unknown as { __deepweAiWorkerRunning?: boolean }).__deepweAiWorkerRunning = true;
    try {
      expect((await recover(completed.event.id, completed.event.aToken, 1)).status).toBe(202);
      expect(db.getAiJob(oldCompleted.id)?.status).toBe("completed");
    } finally {
      const state = globalThis as unknown as { __deepweAiWorkerRunning?: boolean };
      if (wasRunning === undefined) delete state.__deepweAiWorkerRunning;
      else state.__deepweAiWorkerRunning = wasRunning;
    }
    const failed = prepareLegacyRecovery();
    const oldFailed = db.enqueueAiJob(failed.event.id, "merge_correction", "a");
    db.db.prepare(`UPDATE ai_jobs SET status='failed',source_snapshot=NULL,error_code='LEGACY_FAILED' WHERE id=?`).run(oldFailed.id);
    const failedDetail = await getEvent(failed.event.id, failed.event.aToken);
    expect(failedDetail.body.aiJobStatus).toBe("failed");
    expect(failedDetail.body.aiJobRetryAllowed).toBe(false);
    expect(failedDetail.body.mergedRecovery.kind).toBe("available");
    expect(db.retryVisibleAiJob(failed.event.id, "a", oldFailed.id, oldFailed.attempts)).toBe(false);
    const state = globalThis as unknown as { __deepweAiWorkerRunning?: boolean };
    const before = state.__deepweAiWorkerRunning;
    state.__deepweAiWorkerRunning = true;
    try {
      expect((await recover(failed.event.id, failed.event.aToken, 1)).status).toBe(202);
      expect(db.getAiJob(oldFailed.id)?.status).toBe("cancelled");
      expect(db.db.prepare(`SELECT COUNT(*) count FROM ai_jobs WHERE event_id=?`).get(failed.event.id)).toMatchObject({ count: 2 });
    } finally {
      if (before === undefined) delete state.__deepweAiWorkerRunning;
      else state.__deepweAiWorkerRunning = before;
    }
  });

  it("有效报告不重复生成；普通失败沿用 retry，unknown 不可绕过", async () => {
    const noCorrection = createMergedFixture();
    expect((await getEvent(noCorrection.event.id, noCorrection.event.aToken)).body.mergedRecovery).toBeNull();

    const normal = createMergedFixture();
    const initial = db.enqueueAiJob(normal.event.id, "merge_initial");
    db.db.prepare(`UPDATE ai_jobs SET status='completed' WHERE id=?`).run(initial.id);
    db.transition(normal.event.id, "merged", "agreement_proposed");
    expect((await getEvent(normal.event.id, normal.event.aToken)).body.mergedRecovery).toBeNull();

    const correctedHistory = prepareLegacyRecovery();
    const validCorrection = db.enqueueAiJob(correctedHistory.event.id, "merge_correction", "a");
    db.db.prepare(`UPDATE ai_jobs SET status='completed' WHERE id=?`).run(validCorrection.id);
    db.transition(correctedHistory.event.id, "merged", "agreement_proposed");
    expect((await getEvent(correctedHistory.event.id, correctedHistory.event.aToken)).body.mergedRecovery).toBeNull();

    const noCorrectionHistory = createMergedFixture();
    db.transition(noCorrectionHistory.event.id, "merged", "agreement_proposed");
    const noCorrectionDetail = await getEvent(noCorrectionHistory.event.id, noCorrectionHistory.event.aToken);
    expect(noCorrectionDetail.body.mergedRecovery).toBeNull();
    expect(noCorrectionDetail.body.merged).not.toBeNull();

    const current = prepareLegacyRecovery();
    const complete = db.enqueueAiJob(current.event.id, "merge_correction", "a");
    db.db.prepare(`UPDATE ai_jobs SET status='completed' WHERE id=?`).run(complete.id);
    expect((await getEvent(current.event.id, current.event.aToken)).body.mergedRecovery).toBeNull();
    expect((await recover(current.event.id, current.event.aToken, 1)).status).toBe(409);

    const retryable = prepareLegacyRecovery();
    const retryJob = db.enqueueAiJob(retryable.event.id, "merge_correction", "a");
    db.db.prepare(`UPDATE ai_jobs SET status='failed',error_code=NULL WHERE id=?`).run(retryJob.id);
    expect((await getEvent(retryable.event.id, retryable.event.aToken)).body.mergedRecovery).toMatchObject({ kind: "blocked", reason: "已有可重试任务，请从任务提示重试" });
    expect((await recover(retryable.event.id, retryable.event.aToken, 1)).status).toBe(409);
    expect(db.retryVisibleAiJob(retryable.event.id, "a", retryJob.id, retryJob.attempts)).toBe(true);

    const unknown = prepareLegacyRecovery();
    const unknownJob = db.enqueueAiJob(unknown.event.id, "merge_correction", "a");
    db.db.prepare(`UPDATE ai_jobs SET status='failed',error_code='AI_RESULT_UNKNOWN' WHERE id=?`).run(unknownJob.id);
    expect((await getEvent(unknown.event.id, unknown.event.aToken)).body.mergedRecovery).toMatchObject({ kind: "blocked" });
    expect((await recover(unknown.event.id, unknown.event.aToken, 1)).status).toBe(409);
    expect(db.db.prepare(`SELECT COUNT(*) count FROM ai_jobs WHERE event_id=?`).get(unknown.event.id)).toMatchObject({ count: 1 });
  });

  it("active job、未确认摘要、撤回、事件风险、潜谈风险与历史阶段均被拦截", async () => {
    for (const status of ["queued", "processing"] as const) {
      const fixture = prepareLegacyRecovery();
      const job = db.enqueueAiJob(fixture.event.id, "merge_correction", "a");
      db.db.prepare(`UPDATE ai_jobs SET status=? WHERE id=?`).run(status, job.id);
      expect((await getEvent(fixture.event.id, fixture.event.aToken)).body.mergedRecovery).toMatchObject({ kind: "blocked" });
      expect((await recover(fixture.event.id, fixture.event.aToken, 1)).status).toBe(409);
    }

    const unconfirmed = prepareLegacyRecovery();
    db.setSummary(unconfirmed.event.id, "b", JSON.stringify(summaryB));
    expect((await getEvent(unconfirmed.event.id, unconfirmed.event.aToken)).body.mergedRecovery.kind).toBe("blocked");

    const revoked = prepareLegacyRecovery();
    db.db.prepare(`UPDATE events SET state='sharing_revoked' WHERE id=?`).run(revoked.event.id);
    const revokedDetail = await getEvent(revoked.event.id, revoked.event.aToken);
    expect(revokedDetail.body.merged).toBeNull();
    expect(revokedDetail.body.mergedRecovery).toBeNull();
    expect((await recover(revoked.event.id, revoked.event.aToken, 1)).status).toBe(409);

    const risk = prepareLegacyRecovery();
    const owner = await createTestAccount();
    const conversation = privateCore.createConversation(owner.userId);
    db.db.prepare(`UPDATE events SET a_user_id=?,a_conversation_id=? WHERE id=?`).run(owner.userId, conversation.id, risk.event.id);
    db.db.prepare(`INSERT INTO private_risk_state(conversation_id,situation,source_message_ids,updated_at) VALUES(?,?,?,?)`).run(conversation.id, "synthetic", "[]", Date.now());
    expect(db.getMergedRecovery(risk.event.id, "a", owner.userId, null)).toMatchObject({ kind: "blocked" });
    const riskRead = await api.request(`/events/${risk.event.id}`, {
      headers: { Cookie: `${owner.cookie}; ${cookie(risk.event.id, risk.event.aToken)}` },
    });
    const riskBody = await riskRead.json();
    expect(riskBody.sharedSafetyPaused).toBe(true);
    expect(riskBody.mergedRecovery).toBeNull();
    expect(riskBody.mergedVersion).toBeNull();
    expect(riskBody.mergedAConfirmed).toBe(false);
    expect(riskBody.mergedBConfirmed).toBe(false);
    expect((await recover(risk.event.id, risk.event.aToken, 1, owner.cookie)).status).toBe(409);

    const eventRisk = prepareLegacyRecovery();
    db.db.prepare(`UPDATE events SET risk_level='violence' WHERE id=?`).run(eventRisk.event.id);
    expect((await recover(eventRisk.event.id, eventRisk.event.aToken, 1)).status).toBe(409);

    for (const state of ["agreement_proposed", "done", "completed"] as const) {
      const history = prepareLegacyRecovery();
      db.transition(history.event.id, "merged", "agreement_proposed");
      db.setChoice(history.event.id, "a", "只保留原行动");
      if (state !== "agreement_proposed") db.transition(history.event.id, "agreement_proposed", "done");
      if (state === "completed") db.transition(history.event.id, "done", "completed");
      expect((await getEvent(history.event.id, history.event.aToken)).body.mergedRecovery).toMatchObject({ kind: "history" });
      expect((await recover(history.event.id, history.event.aToken, 1)).status).toBe(409);
      expect(db.getEvent(history.event.id)?.state).toBe(state);
      expect(db.getChoices(history.event.id).a).toBe("只保留原行动");
    }
  });

  it("拒绝 stale version；队列写入失败会回滚所有状态", async () => {
    const stale = prepareLegacyRecovery();
    db.db.prepare(`UPDATE merged SET version=version+1 WHERE event_id=?`).run(stale.event.id);
    expect((await recover(stale.event.id, stale.event.aToken, 1)).status).toBe(409);
    expect(db.db.prepare(`SELECT COUNT(*) count FROM ai_jobs WHERE event_id=?`).get(stale.event.id)).toMatchObject({ count: 0 });

    const failed = prepareLegacyRecovery();
    db.confirmMerged(failed.event.id, "a", 1);
    db.confirmMerged(failed.event.id, "b", 1);
    db.db.exec(`CREATE TRIGGER fail_recovery_queue BEFORE INSERT ON ai_jobs WHEN NEW.kind='merge_correction' BEGIN SELECT RAISE(ABORT,'synthetic recovery queue failure'); END`);
    const workerState = globalThis as unknown as { __deepweAiWorkerRunning?: boolean };
    const wasRunning = workerState.__deepweAiWorkerRunning;
    workerState.__deepweAiWorkerRunning = true;
    try {
      expect((await recover(failed.event.id, failed.event.aToken, 1)).status).toBe(503);
      expect(db.getMerged(failed.event.id)).toMatchObject({ a_confirmed: 1, b_confirmed: 1 });
      expect(db.db.prepare(`SELECT COUNT(*) count FROM ai_jobs WHERE event_id=?`).get(failed.event.id)).toMatchObject({ count: 0 });
    } finally {
      db.db.exec("DROP TRIGGER IF EXISTS fail_recovery_queue");
      if (wasRunning === undefined) delete workerState.__deepweAiWorkerRunning;
      else workerState.__deepweAiWorkerRunning = wasRunning;
    }
  });

  it("拒绝 null、数组和缺失版本的恢复请求，不创建任务", async () => {
    const { event } = prepareLegacyRecovery();
    for (const body of ["null", "[]", "{}", JSON.stringify({ expectedVersion: null })]) {
      const response = await api.request(`/events/${event.id}/merged/recover`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie(event.id, event.aToken) },
        body,
      });
      expect(response.status).toBe(400);
    }
    expect(db.db.prepare(`SELECT COUNT(*) count FROM ai_jobs WHERE event_id=?`).get(event.id)).toMatchObject({ count: 0 });
  });
});

describe("伴侣复盘邀请退出", () => {
  it("受邀者在接受前可以拒绝定向邀请", async () => {
    await ensureRouteAdmin();
    const invitee = await createTestAccount();
    const event = db.createEvent("合成邀请");
    db.db.prepare(`UPDATE events SET state='waiting_b',invite_mode='partner_direct',partner_target_user_id=? WHERE id=?`).run(invitee.userId,event.id);
    const response = await api.request(`/events/${event.id}/decline`, {
      method: "POST", headers: { Cookie: invitee.cookie },
    });
    expect(response.status).toBe(200);
    expect(db.getEvent(event.id)?.state).toBe("declined");
    expect(db.getEvent(event.id)?.partner_target_user_id).toBeNull();
  });

  it("已接受的 B 可从自己的账号会话退出", async () => {
    await ensureRouteAdmin();
    const invitee = await createTestAccount();
    const event = db.createEvent("合成已接受邀请");
    db.db.prepare(`UPDATE events SET state='b_guiding',invite_mode='partner_direct',b_user_id=? WHERE id=?`).run(invitee.userId,event.id);
    const response = await api.request(`/events/${event.id}/decline`, {
      method: "POST", headers: { Cookie: invitee.cookie },
    });
    expect(response.status).toBe(200);
    expect(db.getEvent(event.id)?.state).toBe("declined");
  });

  it("旧 B 摘要确认路由不能绕过新私密会话的风险状态", async () => {
    const account=await createTestAccount();
    const event=db.createEvent("合成风险事件");
    db.db.prepare(`UPDATE events SET state='b_summary',b_user_id=? WHERE id=?`).run(account.userId,event.id);
    const conversation=privateCore.createConversation(account.userId,"复盘中的私密表达",{eventId:event.id,side:"b"});
    privateCore.addUserMessage(account.userId,conversation.id,"他现在威胁我，不让我离开。");
    const response=await api.request(`/events/${event.id}/b-summary/confirm`,{
      method:"POST",headers:{"Content-Type":"application/json",Cookie:account.cookie},body:JSON.stringify({}),
    });
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe("ACTIVE_SAFETY_RISK");
  });
});

describe("共享阶段关联私密风险暂停", () => {
  it("A/B 会话绑定按 owner 校验；两侧风险都阻止普通确认、纠偏和摘要确认", async () => {
    for (const riskSide of ["a", "b"] as const) {
      const fixture = await createBoundEventFixture("merged");
      const ev = db.getEvent(fixture.event.id)!;
      const aDetail = await api.request(`/events/${ev.id}`, { headers: { Cookie: fixture.a.cookie } });
      const bDetail = await api.request(`/events/${ev.id}`, { headers: { Cookie: fixture.b.cookie } });
      expect((await aDetail.json()).role).toBe("a");
      expect((await bDetail.json()).role).toBe("b");
      expect(ev.a_user_id).toBe(fixture.a.userId);
      expect(ev.b_user_id).toBe(fixture.b.userId);
      expect(ev.a_conversation_id).toBe(fixture.aConversation.id);
      expect(ev.b_conversation_id).toBe(fixture.bConversation.id);
      expect(db.eventHasActivePrivateRisk(ev.id)).toBe(false);

      const conversation = riskSide === "a" ? fixture.aConversation : fixture.bConversation;
      setSyntheticActiveRisk(conversation.id);
      expect(db.eventHasActivePrivateRisk(ev.id)).toBe(true);
      const foreignConversation = privateCore.createConversation(fixture.b.userId, "错误 owner 合成会话");
      db.db.prepare(`UPDATE events SET a_conversation_id=? WHERE id=?`).run(foreignConversation.id, ev.id);
      expect(db.eventHasActivePrivateRisk(ev.id)).toBe(riskSide === "b");
      db.db.prepare(`UPDATE events SET a_conversation_id=? WHERE id=?`).run(fixture.aConversation.id, ev.id);
      expect(db.eventHasActivePrivateRisk(ev.id)).toBe(true);
      const before = db.getMerged(ev.id)!;
      const jobsBefore = (db.db.prepare(`SELECT COUNT(*) count FROM ai_jobs WHERE event_id=?`).get(ev.id) as { count: number }).count;
      const other = riskSide === "a" ? fixture.b : fixture.a;
      const token = other.cookie;
      const normal = await api.request(`/events/${ev.id}/merged/confirm`, {
        method: "POST", headers: { "Content-Type": "application/json", Cookie: token },
        body: JSON.stringify({ expectedVersion: before.version }),
      });
      const correction = await api.request(`/events/${ev.id}/merged/confirm`, {
        method: "POST", headers: { "Content-Type": "application/json", Cookie: token },
        body: JSON.stringify({ expectedVersion: before.version, correction: "合成纠偏" }),
      });
      expect(normal.status).toBe(409);
      expect((await normal.json()).code).toBe("ACTIVE_SAFETY_RISK");
      expect(correction.status).toBe(409);
      expect(db.getEvent(ev.id)?.state).toBe("merged");
      expect(db.getMerged(ev.id)).toEqual(before);
      expect((db.db.prepare(`SELECT COUNT(*) count FROM ai_jobs WHERE event_id=?`).get(ev.id) as { count: number }).count).toBe(jobsBefore);
    }

    const bSummary = await createBoundEventFixture("b_summary");
    setSyntheticActiveRisk(bSummary.aConversation.id);
    const summaryBefore = db.getPerspective(bSummary.event.id, "b")!;
    const response = await api.request(`/events/${bSummary.event.id}/b-summary/confirm`, {
      method: "POST", headers: { "Content-Type": "application/json", Cookie: bSummary.b.cookie }, body: JSON.stringify({}),
    });
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe("ACTIVE_SAFETY_RISK");
    expect(db.getEvent(bSummary.event.id)?.state).toBe("b_summary");
    expect(db.getPerspective(bSummary.event.id, "b")?.summary_confirmed).toBe(summaryBefore.summary_confirmed);
    expect(db.getUnresolvedAiJob(bSummary.event.id)).toBeUndefined();

    const privateSummary = await createBoundEventFixture("b_guiding");
    setSyntheticActiveRisk(privateSummary.aConversation.id);
    const bPrivate = privateCore.getConversationById(privateSummary.b.userId, privateSummary.bConversation.id)!;
    expect(privateCore.confirmEventSummary(privateSummary.b.userId, bPrivate.id, "B 合成摘要", bPrivate.version)).toBe("active_risk");
    expect(db.getEvent(privateSummary.event.id)?.state).toBe("b_guiding");
    expect(db.getUnresolvedAiJob(privateSummary.event.id)).toBeUndefined();

    const recovery = await createBoundEventFixture("merged");
    db.setCorrection(recovery.event.id, "a", "合成旧版纠偏");
    setSyntheticActiveRisk(recovery.aConversation.id);
    const beforeVersion = db.getMerged(recovery.event.id)!.version;
    const recoveryResponse = await api.request(`/events/${recovery.event.id}/merged/recover`, {
      method: "POST", headers: { "Content-Type": "application/json", Cookie: recovery.a.cookie },
      body: JSON.stringify({ expectedVersion: beforeVersion }),
    });
    expect(recoveryResponse.status).toBe(409);
    expect((await recoveryResponse.json()).code).toBe("RECOVERY_UNAVAILABLE");
    expect(db.getMerged(recovery.event.id)?.version).toBe(beforeVersion);
    expect(db.getUnresolvedAiJob(recovery.event.id)).toBeUndefined();
  });

  it("暂停只返回中性布尔值，拒绝行动和复盘，撤回后仍按旧隔离处理", async () => {
    const mergedFixture = await createBoundEventFixture("merged");
    setSyntheticActiveRisk(mergedFixture.aConversation.id);
    const aRead = await api.request(`/events/${mergedFixture.event.id}`, { headers: { Cookie: mergedFixture.a.cookie } });
    const bRead = await api.request(`/events/${mergedFixture.event.id}`, { headers: { Cookie: mergedFixture.b.cookie } });
    const aBody = await aRead.json();
    const bBody = await bRead.json();
    expect(aBody.role).toBe("a");
    expect(bBody.role).toBe("b");
    for (const body of [aBody, bBody]) {
      expect(body.sharedSafetyPaused).toBe(true);
      expect(body.merged).toBeNull();
      expect(body.mergedVersion).toBeNull();
      expect(body.mergedAConfirmed).toBe(false);
      expect(body.mergedBConfirmed).toBe(false);
      expect(body.choices).toEqual({});
      expect(body.reviewAvailable).toBe(false);
      expect(JSON.stringify(body)).not.toContain("synthetic-risk-marker");
      expect(body).not.toHaveProperty("situation");
    }
    const guest = await api.request(`/events/${mergedFixture.event.id}`);
    expect(guest.status).toBe(404);
    expect(await guest.json()).not.toHaveProperty("sharedSafetyPaused");

    const agreement = await createBoundEventFixture("agreement_proposed");
    setSyntheticActiveRisk(agreement.aConversation.id);
    const priorChoices = db.getChoices(agreement.event.id);
    const choice = await api.request(`/events/${agreement.event.id}/agreement`, {
      method: "POST", headers: { "Content-Type": "application/json", Cookie: agreement.b.cookie },
      body: JSON.stringify({ choice: "B 新合成行动" }),
    });
    expect(choice.status).toBe(409);
    expect(db.getEvent(agreement.event.id)?.state).toBe("agreement_proposed");
    expect(db.getChoices(agreement.event.id)).toEqual(priorChoices);

    const done = await createBoundEventFixture("done");
    setSyntheticActiveRisk(done.aConversation.id);
    const reviewBefore = db.getReviews(done.event.id);
    const review = await api.request(`/events/${done.event.id}/review`, {
      method: "POST", headers: { "Content-Type": "application/json", Cookie: done.b.cookie },
      body: JSON.stringify({ executed: "合成完成", effect: "合成效果", next: "合成下一步" }),
    });
    expect(review.status).toBe(409);
    expect(db.getEvent(done.event.id)?.state).toBe("done");
    expect(db.getReviews(done.event.id)).toEqual(reviewBefore);

    const revoked = await createBoundEventFixture("sharing_revoked");
    setSyntheticActiveRisk(revoked.aConversation.id);
    const revokedRead = await api.request(`/events/${revoked.event.id}`, { headers: { Cookie: revoked.b.cookie } });
    const revokedBody = await revokedRead.json();
    expect(revokedBody.sharedSafetyPaused).toBe(false);
    expect(revokedBody.sharingRevoked).toBe(true);
    expect(revokedBody.merged).toBeNull();
    expect(revokedBody.risk).toBe("none");
    expect(JSON.stringify(revokedBody)).not.toContain("synthetic-risk-marker");
  });

  it("关联风险在所有明确共享阶段都设置 sharedSafetyPaused", async () => {
    for (const state of ["a_summary", "waiting_b", "b_guiding", "b_summary", "merged", "agreement_proposed", "done"] as const) {
      const fixture = await createBoundEventFixture(state);
      setSyntheticActiveRisk(fixture.aConversation.id);
      const response = await api.request(`/events/${fixture.event.id}`, { headers: { Cookie: fixture.b.cookie } });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.state).toBe(state);
      expect(body.sharedSafetyPaused).toBe(true);
    }

    for (const state of ["sharing_revoked", "completed", "closed"] as const) {
      const fixture = await createBoundEventFixture(state === "completed" || state === "closed" ? "merged" : state);
      if (state !== "sharing_revoked") db.db.prepare(`UPDATE events SET state=? WHERE id=?`).run(state, fixture.event.id);
      setSyntheticActiveRisk(fixture.aConversation.id);
      const response = await api.request(`/events/${fixture.event.id}`, { headers: { Cookie: fixture.b.cookie } });
      const body = await response.json();
      expect(body.sharedSafetyPaused).toBe(false);
    }
  });

  it("释放风险不自动复活结果，也不清除 AI_RESULT_UNKNOWN", async () => {
    const fixture = await createBoundEventFixture("merged");
    setSyntheticActiveRisk(fixture.aConversation.id);
    db.setCorrection(fixture.event.id, "b", "合成纠偏来源");
    const unknown = db.enqueueAiJob(fixture.event.id, "merge_correction", "b");
    db.db.prepare(`UPDATE ai_jobs SET status='failed',error_code='AI_RESULT_UNKNOWN' WHERE id=?`).run(unknown.id);
    const paused = await api.request(`/events/${fixture.event.id}`, { headers: { Cookie: fixture.a.cookie } });
    const pausedBody = await paused.json();
    expect(pausedBody.sharedSafetyPaused).toBe(true);
    expect(pausedBody.merged).toBeNull();
    expect(pausedBody.mergedRecovery).toBeNull();
    expect(pausedBody.aiJobStatus).toBe("failed");
    expect(pausedBody.aiJobErrorCode).toBe("AI_RESULT_UNKNOWN");
    expect(pausedBody.aiJobRetryAllowed).toBe(false);

    db.db.prepare(`DELETE FROM private_risk_state WHERE conversation_id=?`).run(fixture.aConversation.id);
    const resumed = await api.request(`/events/${fixture.event.id}`, { headers: { Cookie: fixture.a.cookie } });
    const resumedBody = await resumed.json();
    expect(resumedBody.sharedSafetyPaused).toBe(false);
    expect(resumedBody.merged).toBeNull();
    expect(resumedBody.aiJobStatus).toBe("failed");
    expect(resumedBody.aiJobErrorCode).toBe("AI_RESULT_UNKNOWN");
    expect(resumedBody.aiJobRetryAllowed).toBe(false);
    expect(db.getAiJob(unknown.id)?.status).toBe("failed");

    const retryable = await createBoundEventFixture("merged");
    db.setCorrection(retryable.event.id, "b", "合成可重试纠偏");
    const retryJob = db.enqueueAiJob(retryable.event.id, "merge_correction", "b");
    db.db.prepare(`UPDATE ai_jobs SET status='failed',error_code='SYNTHETIC_FAILURE' WHERE id=?`).run(retryJob.id);
    setSyntheticActiveRisk(retryable.aConversation.id);
    expect(db.retryVisibleAiJob(retryable.event.id, "b", retryJob.id, retryJob.attempts)).toBe(false);
    db.db.prepare(`DELETE FROM private_risk_state WHERE conversation_id=?`).run(retryable.aConversation.id);
    expect(db.retryVisibleAiJob(retryable.event.id, "b", retryJob.id, retryJob.attempts)).toBe(true);
    db.cancelAiJob(retryJob.id);
  });

  it("共同确认请求拒绝 null、数组和非字符串纠偏", async () => {
    const fixture = await createBoundEventFixture("merged");
    const before = db.getMerged(fixture.event.id)!;
    for (const body of ["null", "[]", JSON.stringify({ expectedVersion: 1, correction: null }), JSON.stringify({ expectedVersion: 1, correction: 12 })]) {
      const response = await api.request(`/events/${fixture.event.id}/merged/confirm`, {
        method: "POST", headers: { "Content-Type": "application/json", Cookie: fixture.a.cookie }, body,
      });
      expect(response.status).toBe(400);
    }
    expect(db.getMerged(fixture.event.id)).toEqual(before);
    expect(db.getEvent(fixture.event.id)?.state).toBe("merged");
    expect(db.db.prepare(`SELECT COUNT(*) count FROM ai_jobs WHERE event_id=?`).get(fixture.event.id)).toMatchObject({ count: 0 });
  });
});

describe("私密笔记纠正", () => {
  it("空白纠正通过接口返回400", async () => {
    const account=await createTestAccount();
    const conversation=privateCore.createConversation(account.userId);
    const source=privateCore.addUserMessage(account.userId,conversation.id,"合成表达")!;
    const noteId=db.randomToken();
    db.db.prepare(`INSERT INTO private_notes(id,conversation_id,kind,content,source_message_ids,source_message_versions,source_conversation_version,version,status,updated_at)
      VALUES(?,?,'user_statement','合成笔记',?,?,?,1,'current',?)`).run(noteId,conversation.id,JSON.stringify([source.message.id]),JSON.stringify({[source.message.id]:source.message.version}),privateCore.getConversationById(account.userId,conversation.id)!.version,Date.now());
    const before=privateCore.getConversationById(account.userId,conversation.id)!.version;
    const response=await api.request(`/conversations/${conversation.id}/notes/${noteId}`,{
      method:"PATCH",headers:{"Content-Type":"application/json",Cookie:account.cookie},body:JSON.stringify({correction:" \n ",expectedVersion:1}),
    });
    expect(response.status).toBe(400);
    expect(privateCore.getConversationById(account.userId,conversation.id)!.version).toBe(before);
  });

  it("HTTP 接口对来源已编辑的旧笔记返回 409", async () => {
    const account=await createTestAccount();
    const conversation=privateCore.createConversation(account.userId);
    const source=privateCore.addUserMessage(account.userId,conversation.id,"原始合成表达")!;
    const noteId=db.randomToken();
    db.db.prepare(`INSERT INTO private_notes(id,conversation_id,kind,content,source_message_ids,source_message_versions,source_conversation_version,version,status,updated_at)
      VALUES(?,?,'user_statement','合成笔记',?,?,?,1,'current',?)`).run(noteId,conversation.id,JSON.stringify([source.message.id]),JSON.stringify({[source.message.id]:source.message.version}),privateCore.getConversationById(account.userId,conversation.id)!.version,Date.now());
    privateCore.editUserMessage(account.userId,conversation.id,source.message.id,"修订后的表达",privateCore.getConversationById(account.userId,conversation.id)!.version);
    const response=await api.request(`/conversations/${conversation.id}/notes/${noteId}`,{
      method:"PATCH",headers:{"Content-Type":"application/json",Cookie:account.cookie},body:JSON.stringify({correction:"过期纠正",expectedVersion:2}),
    });
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe("STALE_VERSION");
  });
});

describe("私密回复反馈", () => {
  it("仅接受最新回复的固定反馈，并按会话保存、撤回偏好", async () => {
    const account=await createTestAccount(),conversation=privateCore.createConversation(account.userId);
    const source=privateCore.addUserMessage(account.userId,conversation.id,"合成的最新表达")!;
    db.db.prepare(`UPDATE private_jobs SET status='cancelled' WHERE conversation_id=?`).run(conversation.id);
    const assistantId=db.randomToken();
    db.db.prepare(`INSERT INTO private_messages(id,conversation_id,role,content,version,status,created_at) VALUES(?,?, 'assistant', ?,1,'current',?)`).run(assistantId,conversation.id,"合成回复",Date.now()+1);
    const version=privateCore.getConversationById(account.userId,conversation.id)!.version;
    const endpoint=`/conversations/${conversation.id}/messages/${assistantId}/feedback`;
    const send=(body:unknown)=>api.request(endpoint,{method:"POST",headers:{"Content-Type":"application/json",Cookie:account.cookie},body:JSON.stringify(body)});

    for(const body of [null,[],"text"])expect((await send(body)).status).toBe(400);
    expect((await send({rating:"down",reason:"clear",expectedVersion:version})).status).toBe(400);
    expect((await send({rating:"down",reason:"too_many_questions",expectedVersion:version,body:"freeform"})).status).toBe(400);
    const stale=await send({rating:"down",reason:"too_many_questions",expectedVersion:version-1});
    expect(stale.status).toBe(409);
    expect((await stale.json()).code).toBe("VERSION_CONFLICT");

    const accepted=await send({rating:"down",reason:"too_many_questions",expectedVersion:version});
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({feedback:{rating:"down",reason:"too_many_questions"},responsePreferences:["少追问，一次最多问一个问题"]});
    const detail=await api.request(`/conversations/${conversation.id}`,{headers:{Cookie:account.cookie}});
    expect(await detail.json()).toMatchObject({latestTurn:{userMessageId:source.message.id,assistantMessageId:assistantId},replyFeedback:{rating:"down",reason:"too_many_questions"},responsePreferences:["少追问，一次最多问一个问题"]});

    const cleared=await api.request(`/conversations/${conversation.id}/response-preferences`,{method:"DELETE",headers:{"Content-Type":"application/json",Cookie:account.cookie},body:JSON.stringify({expectedVersion:version})});
    expect(await cleared.json()).toEqual({feedback:null,responsePreferences:[]});
    expect(privateCore.listResponsePreferences(account.userId,conversation.id)).toEqual([]);
    const malformedClear=await api.request(`/conversations/${conversation.id}/response-preferences`,{method:"DELETE",headers:{"Content-Type":"application/json",Cookie:account.cookie},body:"null"});
    expect(malformedClear.status).toBe(400);
  });
});

describe("完成态与复访", () => {
  it("没有纠偏的历史完成态沿用旧展示并保留双方行动和复盘", async () => {
    const { event } = createMergedFixture();
    db.confirmMerged(event.id, "a");
    db.confirmMerged(event.id, "b");
    db.transition(event.id, "merged", "agreement_proposed");
    db.setChoice(event.id, "a", "A 的行动");
    db.setChoice(event.id, "b", "B 的行动");
    db.markAgreementDone(event.id);
    db.transition(event.id, "agreement_proposed", "done");
    db.setReview(event.id, "a", JSON.stringify({ executed: "是", effect: "有效", next: "继续" }));
    db.setReview(event.id, "b", JSON.stringify({ executed: "是", effect: "有效", next: "继续" }));
    db.transition(event.id, "done", "completed");

    const result = await getEvent(event.id, event.aToken);
    expect(result.body.state).toBe("completed");
    expect(result.body.merged.event_summary).toBe(merged.event_summary);
    expect(result.body.mergedRecovery).toBeNull();
    expect(result.body.bSummary.observation).toBe(summaryB.observation);
    expect(result.body.choices).toEqual({ a: "A 的行动", b: "B 的行动" });
    expect(result.body.aReview.executed).toBe("是");
    expect(result.body.bReview.executed).toBe("是");
  });

  it("约定日期前不能提交复访", async () => {
    const { event } = createMergedFixture();
    db.transition(event.id, "merged", "agreement_proposed");
    db.setChoice(event.id, "a", "A 的行动");
    db.setChoice(event.id, "b", "B 的行动");
    db.markAgreementDone(event.id);
    db.transition(event.id, "agreement_proposed", "done");

    const response = await api.request("/events/" + event.id + "/review", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookie(event.id, event.aToken),
      },
      body: JSON.stringify({ executed: "是", effect: "有效", next: "继续" }),
    });

    expect(response.status).toBe(409);
    expect(db.getReviews(event.id).a).toBeUndefined();
  });
});

describe("AI 失败恢复", () => {
  it("引导回复失败不阻塞提交，并用本地承接避免用户断联", async () => {
    process.env.DEEPSEEK_API_KEY = "test-key";
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const event = db.createEvent("AI 失败测试");

    const response = await api.request("/events/" + event.id + "/guide", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookie(event.id, event.aToken),
      },
      body: JSON.stringify({ message: "这是一条虚构测试消息" }),
    });

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual(expect.objectContaining({ queued: true }));
    await vi.waitFor(() => {
      expect(db.getGuideMessages(event.id, "a")).toHaveLength(2);
    });
    expect(db.getGuideMessages(event.id, "a")).toEqual([
      expect.objectContaining({ role: "a", content: "这是一条虚构测试消息" }),
      expect.objectContaining({ role: "ai" }),
    ]);
    expect(db.getEvent(event.id)?.state).toBe("a_guiding");
  });

  it("只能修改最新一轮，历史消息保持只读", async () => {
    process.env.DEEPSEEK_API_KEY = "test-key";
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const event = db.createEvent("消息修改测试");
    db.upsertPerspective(event.id, "a", "最初的虚构表达");
    const firstId = db.addGuideMessage(event.id, "a", "a", "把周六写成了周日");
    const aiId = db.addGuideMessage(event.id, "a", "ai", "基于错误日期的旧回复");
    const latestId = db.addGuideMessage(event.id, "a", "a", "沿着旧回复继续说");
    db.addGuideMessage(event.id, "a", "ai", "另一条需要撤回的旧回复");
    db.saveGuideSession(
      event.id,
      "a",
      "checkin",
      JSON.stringify({ ...emptyStoryMap(), context: "包含错误日期的旧故事地图" })
    );

    const cannotEditAi = await api.request(
      `/events/${event.id}/guide/messages/${aiId}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: cookie(event.id, event.aToken) },
        body: JSON.stringify({ message: "不能修改 AI 的消息" }),
      }
    );
    expect(cannotEditAi.status).toBe(409);

    const oldResponse = await api.request(
      `/events/${event.id}/guide/messages/${firstId}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: cookie(event.id, event.aToken) },
        body: JSON.stringify({ message: "尝试修改历史消息" }),
      }
    );
    expect(oldResponse.status).toBe(409);
    expect(db.getGuideMessages(event.id, "a")[0]).toEqual(
      expect.objectContaining({ id: firstId, content: "把周六写成了周日" })
    );

    const response = await api.request(
      `/events/${event.id}/guide/messages/${latestId}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: cookie(event.id, event.aToken) },
        body: JSON.stringify({ message: "修正刚刚发出的最新内容" }),
      }
    );

    expect(response.status).toBe(202);
    expect(db.getGuideMessages(event.id, "a")[2]).toEqual(
      expect.objectContaining({ id: latestId, role: "a", content: "修正刚刚发出的最新内容" })
    );
    expect(db.getGuideSession(event.id, "a")?.stage).toBe("story");
    expect(JSON.parse(db.getGuideSession(event.id, "a")!.story_map)).toEqual(emptyStoryMap());
    await vi.waitFor(() => {
      expect(db.getGuideMessages(event.id, "a")).toHaveLength(4);
    });
  });

  it("用户可以停止正在生成的回复", async () => {
    const event = db.createEvent("停止生成测试");
    const messageId = db.addGuideMessage(event.id, "a", "a", "暂时不需要继续生成");
    const job = db.enqueueAiJob(event.id, "guide", "a", messageId);
    const response = await api.request(`/events/${event.id}/ai/stop`, {
      method: "POST",
      headers: { Cookie: cookie(event.id, event.aToken) },
    });
    expect(response.status).toBe(200);
    expect(db.getAiJob(job.id)?.status).toBe("cancelled");
  });

  it("撤销消息会同时移除它之后依赖旧内容的对话", async () => {
    const event = db.createEvent("撤销消息测试");
    const keptId = db.addGuideMessage(event.id, "a", "a", "保留的内容");
    db.addGuideMessage(event.id, "a", "ai", "保留的回复");
    const removedId = db.addGuideMessage(event.id, "a", "a", "误发送的内容");
    db.addGuideMessage(event.id, "a", "ai", "依赖误发内容的回复");
    const historicalResponse = await api.request(
      `/events/${event.id}/guide/messages/${keptId}`,
      { method: "DELETE", headers: { Cookie: cookie(event.id, event.aToken) } }
    );
    expect(historicalResponse.status).toBe(409);
    expect(db.getGuideMessages(event.id, "a")).toHaveLength(4);

    const response = await api.request(
      `/events/${event.id}/guide/messages/${removedId}`,
      { method: "DELETE", headers: { Cookie: cookie(event.id, event.aToken) } }
    );
    expect(response.status).toBe(200);
    expect(db.getGuideMessages(event.id, "a")).toEqual([
      expect.objectContaining({ id: keptId, content: "保留的内容" }),
      expect.objectContaining({ role: "ai", content: "保留的回复" }),
    ]);
  });

  it("没理解我会记录原因并从原消息重新回答", async () => {
    process.env.DEEPSEEK_API_KEY = "test-key";
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const event = db.createEvent("重新回答测试");
    const messageId = db.addGuideMessage(event.id, "a", "a", "请重新理解这句话");
    db.addGuideMessage(event.id, "a", "ai", "没有理解准确的旧回复");
    const response = await api.request(
      `/events/${event.id}/guide/messages/${messageId}/regenerate`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie(event.id, event.aToken) },
        body: JSON.stringify({ reason: "理解错了" }),
      }
    );
    expect(response.status).toBe(202);
    expect(db.getGuideMessages(event.id, "a")[0]).toEqual(
      expect.objectContaining({ id: messageId, content: "请重新理解这句话" })
    );
    await vi.waitFor(() => {
      expect(db.getGuideMessages(event.id, "a")).toHaveLength(2);
    });
  });

  it("不能重新生成很早之前的回复，只允许处理最新一轮", async () => {
    const event = db.createEvent("旧回复不可重置测试");
    const oldMessageId = db.addGuideMessage(event.id, "a", "a", "较早的一轮内容");
    db.addGuideMessage(event.id, "a", "ai", "较早的一轮回复");
    db.addGuideMessage(event.id, "a", "a", "最新一轮内容");
    db.addGuideMessage(event.id, "a", "ai", "最新一轮回复");

    const response = await api.request(
      `/events/${event.id}/guide/messages/${oldMessageId}/regenerate`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie(event.id, event.aToken) },
        body: JSON.stringify({ reason: "尝试重置旧回复" }),
      }
    );

    expect(response.status).toBe(409);
    expect(db.getGuideMessages(event.id, "a")).toHaveLength(4);
  });
});

describe("潜谈由用户决定何时结束", () => {
  it("用户可以在任何时候主动结束并选择整理表达", async () => {
    delete process.env.DEEPSEEK_API_KEY;
    const event = db.createEvent("主动结束测试");
    db.upsertPerspective(event.id, "a", "只有一句开头");
    db.saveGuideSession(event.id, "a", "story", JSON.stringify(emptyStoryMap()));

    const response = await api.request("/events/" + event.id + "/guide/finish", {
      method: "POST",
      headers: { Cookie: cookie(event.id, event.aToken) },
    });

    expect(response.status).toBe(202);
    await vi.waitFor(() => {
      expect(db.getEvent(event.id)?.state).toBe("a_summary");
    });
    expect(db.getPerspective(event.id, "a")?.summary).toBeTruthy();
  });

  it("信息齐全后仍保持正常潜谈，只有用户主动结束才整理表达", async () => {
    delete process.env.DEEPSEEK_API_KEY;
    const event = db.createEvent("本人确认测试");
    db.upsertPerspective(event.id, "a", "虚构的完整故事");
    db.addGuideMessage(event.id, "a", "a", "虚构的完整故事");
    const story: StoryMap = {
      context: "周末约会前",
      timeline: ["先约好见面", "后来临时取消"],
      words_actions: ["对方发消息说今天不来了"],
      outcome: "双方停止聊天",
      feelings: ["失落"],
      impact: "当晚没有休息好",
      needs: ["提前沟通"],
      expectations: "有变化时尽早告知",
      facts: ["约会被取消"],
      interpretations: ["用户担心自己不被重视"],
      unknowns: ["取消的具体原因尚未确认"],
    };
    db.saveGuideSession(event.id, "a", "checkin", JSON.stringify(story));

    expect(db.getEvent(event.id)?.state).toBe("a_guiding");
    expect(db.getPerspective(event.id, "a")?.summary).toBeNull();

    const response = await api.request("/events/" + event.id + "/guide/finish", {
      method: "POST",
      headers: { Cookie: cookie(event.id, event.aToken) },
    });

    expect(response.status).toBe(202);
    await vi.waitFor(() => {
      expect(db.getEvent(event.id)?.state).toBe("a_summary");
    });
    expect(db.getPerspective(event.id, "a")?.summary).toBeTruthy();
    expect(db.getGuideSession(event.id, "a")?.story_confirmed).toBe(1);
  });

  it("摘要已经出现后仍可返回潜谈，旧摘要不会被继续使用", async () => {
    const event = db.createEvent("摘要返回潜谈测试");
    db.upsertPerspective(event.id, "a", "虚构内容");
    db.setSummary(event.id, "a", JSON.stringify(summaryA));
    db.saveGuideSession(event.id, "a", "review", JSON.stringify({
      context: "虚构背景",
      timeline: ["虚构经过"],
      words_actions: ["虚构言行"],
      outcome: "虚构结果",
      feelings: ["难过"],
      impact: "虚构影响",
      needs: ["被理解"],
      expectations: "希望被倾听",
      facts: [],
      interpretations: [],
      unknowns: [],
    } satisfies StoryMap));
    db.transition(event.id, "a_guiding", "a_summary");

    const response = await api.request("/events/" + event.id + "/summary/continue", {
      method: "POST",
      headers: { Cookie: cookie(event.id, event.aToken) },
    });

    expect(response.status).toBe(200);
    expect(db.getEvent(event.id)?.state).toBe("a_guiding");
    expect(db.getPerspective(event.id, "a")?.summary).toBeNull();
    expect(db.getGuideSession(event.id, "a")?.stage).toBe("checkin");
  });

  it("用户可以只结束而不生成内容，未完成 AI 任务同时取消", async () => {
    const event = db.createEvent("只结束潜谈测试");
    const messageId = db.addGuideMessage(event.id, "a", "a", "虚构测试内容");
    const job = db.enqueueAiJob(event.id, "guide", "a", messageId);

    const response = await api.request("/events/" + event.id + "/guide/end", {
      method: "POST",
      headers: {
        Cookie: cookie(event.id, event.aToken),
      },
    });

    expect(response.status).toBe(200);
    expect(db.getEvent(event.id)?.state).toBe("closed");
    expect(db.getAiJob(job.id)?.status).toBe("cancelled");
    expect(db.getPerspective(event.id, "a")?.summary).toBeUndefined();

    db.completeGuideAiJob(job, "不应保存的回复", "story", JSON.stringify(emptyStoryMap()));
    expect(db.getGuideMessages(event.id, "a")).toHaveLength(1);
  });
});

describe("撤回邀请后可以继续处理", () => {
  function createWaitingFixture() {
    const event = db.createEvent("撤回后恢复测试");
    db.upsertPerspective(event.id, "a", "已经说过的虚构私密内容");
    db.addGuideMessage(event.id, "a", "a", "已经说过的虚构私密内容");
    db.setSummary(event.id, "a", JSON.stringify(summaryA));
    db.confirmSummary(event.id, "a");
    db.saveGuideSession(event.id, "a", "review", JSON.stringify(emptyStoryMap()));
    db.confirmGuideStory(event.id, "a");
    db.transition(event.id, "a_guiding", "a_summary");
    db.transition(event.id, "a_summary", "waiting_b");
    return event;
  }

  function createCancelledFixture() {
    const event = createWaitingFixture();
    db.transition(event.id, "waiting_b", "cancelled");
    return event;
  }

  it("继续聊会保留原消息并让旧摘要失效", async () => {
    const event = createCancelledFixture();
    const response = await api.request(`/events/${event.id}/withdraw/continue`, {
      method: "POST",
      headers: { Cookie: cookie(event.id, event.aToken) },
    });

    expect(response.status).toBe(200);
    expect(db.getEvent(event.id)?.state).toBe("a_guiding");
    expect(db.getPerspective(event.id, "a")?.summary).toBeNull();
    expect(db.getPerspective(event.id, "a")?.summary_confirmed).toBe(0);
    expect(db.getGuideSession(event.id, "a")?.stage).toBe("checkin");
    expect(db.getGuideMessages(event.id, "a")).toEqual([
      expect.objectContaining({ role: "a", content: "已经说过的虚构私密内容" }),
      expect.objectContaining({ role: "ai", content: expect.stringContaining("接着聊") }),
    ]);
  });

  it("重新提交会保留已确认表达并让旧邀请码永久失效", async () => {
    const event = createCancelledFixture();
    const oldCode = event.code;
    const response = await api.request(`/events/${event.id}/withdraw/resubmit`, {
      method: "POST",
      headers: { Cookie: cookie(event.id, event.aToken) },
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.state).toBe("waiting_b");
    expect(body.code).toBeUndefined();
    expect(db.getEvent(event.id)?.code).not.toBe(oldCode);
    expect(db.getEventByCode(oldCode)).toBeUndefined();
    expect(db.getPerspective(event.id, "a")?.summary_confirmed).toBe(1);

    const repeated = await api.request(`/events/${event.id}/withdraw/resubmit`, {
      method: "POST",
      headers: { Cookie: cookie(event.id, event.aToken) },
    });
    expect(repeated.status).toBe(409);
  });

  it("发起者能看到邀请码从等待激活变为已激活", async () => {
    const event = createWaitingFixture();
    const waiting = await getEvent(event.id, event.aToken);
    expect(waiting.body.inviteStatus).toBe("waiting");

    db.setBParticipant(event.id, db.randomToken(), "joined-test-user");
    db.transition(event.id, "waiting_b", "b_guiding");
    const activated = await getEvent(event.id, event.aToken);
    expect(activated.body.inviteStatus).toBe("activated");

    const guest = await getEvent(event.id);
    expect(guest.response.status).toBe(404);
    expect(Object.keys(guest.body)).toEqual(["error"]);
  });

  it("过期邀请码会明确显示并可直接生成新码", async () => {
    const event = createWaitingFixture();
    const oldCode = event.code;
    db.db
      .prepare(`UPDATE events SET invite_created_at = ? WHERE id = ?`)
      .run(Date.now() - 8 * 24 * 60 * 60 * 1000, event.id);

    const expired = await getEvent(event.id, event.aToken);
    expect(expired.body.inviteStatus).toBe("expired");

    const response = await api.request(`/events/${event.id}/invite/refresh`, {
      method: "POST",
      headers: { Cookie: cookie(event.id, event.aToken) },
    });
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.code).not.toBe(oldCode);
    expect(db.getEventByCode(oldCode)).toBeUndefined();

    const refreshed = await getEvent(event.id, event.aToken);
    expect(refreshed.body.inviteStatus).toBe("waiting");
  });
});

describe("高风险分流", () => {
  it("出现明确暴力或控制风险时停止普通调解", async () => {
    const accountCookie = await createAccountCookie();
    const response = await api.request("/events", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: accountCookie },
      body: JSON.stringify({
        title: "虚构安全测试",
        rawText: "对方掐脖子并威胁我不许出门",
      }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(db.getEvent(body.id)?.state).toBe("safety_exit");
    expect(db.getEvent(body.id)?.risk_level).toBe("violence");
  });

  it("明确否认暴力时不因单个关键词误退出", async () => {
    delete process.env.DEEPSEEK_API_KEY;
    const accountCookie = await createAccountCookie();
    const response = await api.request("/events", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: accountCookie },
      body: JSON.stringify({
        title: "虚构普通分歧",
        rawText: "我们没有家暴，也不存在暴力，只是周末安排没说清楚",
      }),
    });
    const body = await response.json();

    expect(response.status).toBe(202);
    expect(db.getEvent(body.id)?.state).toBe("a_guiding");
  });

  it("明确否认自伤和精神症状时继续普通对话", async () => {
    delete process.env.DEEPSEEK_API_KEY;
    const accountCookie = await createAccountCookie();
    const response = await api.request("/events", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: accountCookie },
      body: JSON.stringify({
        title: "虚构否定风险测试",
        rawText: "我没有想过自杀，也没有自残和幻听，只是争吵后很难受",
      }),
    });
    const body = await response.json();

    expect(response.status).toBe(202);
    expect(db.getEvent(body.id)?.state).toBe("a_guiding");
    expect(db.getEvent(body.id)?.risk_level).toBe("none");
  });

  it("过去否认风险但当前明确危险时仍优先安全分流", async () => {
    const accountCookie = await createAccountCookie();
    const response = await api.request("/events", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: accountCookie },
      body: JSON.stringify({
        title: "虚构当前风险测试",
        rawText: "我以前没有想过自杀，但我现在不想活了",
      }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(db.getEvent(body.id)?.state).toBe("safety_exit");
    expect(db.getEvent(body.id)?.risk_level).toBe("self_harm");
  });
});
