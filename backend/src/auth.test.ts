import { beforeAll, describe, expect, it } from "vitest";
import api from "./routes";
import * as db from "./db";

let sequence = 0;
let adminCookie = "";

beforeAll(async () => {
  delete process.env.DEEPWE_OWNER_USER_ID;
  const response = await api.request("/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      displayName: "测试管理员",
      email: "admin@deepwe.test",
      password: "admin-test-password",
    }),
  });
  expect(response.status).toBe(201);
  const registered = (await response.clone().json()).user;
  expect(registered.isAdmin).toBe(false);
  expect(registered.isOwner).toBe(false);
  process.env.DEEPWE_OWNER_USER_ID = registered.id;
  adminCookie = String(response.headers.get("set-cookie")).split(";")[0];
  const me = await api.request("/auth/me", { headers: { Cookie: adminCookie } });
  expect((await me.json()).user).toEqual(expect.objectContaining({ isOwner: true, isAdmin: true }));
});

async function createRegistrationCode(note = "自动测试邀请"): Promise<string> {
  const response = await api.request("/admin/registration-invites", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: adminCookie },
    body: JSON.stringify({ note }),
  });
  expect(response.status).toBe(201);
  return (await response.json()).invite.code;
}

async function registerAccount(label = "账号测试用户") {
  sequence += 1;
  const email = `account-${sequence}@deepwe.test`;
  const password = "deepwe-test-password";
  const registrationCode = await createRegistrationCode();
  const response = await api.request("/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ displayName: label, email, password, registrationCode }),
  });
  const body = await response.json();
  const cookie = String(response.headers.get("set-cookie")).split(";")[0];
  return { response, body, cookie, email, password };
}

describe("账号注册与登录", () => {
  it("密码只保存加密结果，登录会话使用 HttpOnly Cookie", async () => {
    const result = await registerAccount();

    expect(result.response.status).toBe(201);
    expect(result.body.user).toEqual(
      expect.objectContaining({ email: result.email, displayName: "账号测试用户" })
    );
    expect(result.body.user).not.toHaveProperty("password");
    expect(result.response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(result.response.headers.get("set-cookie")).toContain("SameSite=Lax");

    const stored = db.getUserByEmail(result.email)!;
    expect(stored.password_hash).not.toBe(result.password);
    expect(stored.password_hash).toHaveLength(128);
    expect(stored.password_salt).toHaveLength(32);

    const me = await api.request("/auth/me", { headers: { Cookie: result.cookie } });
    expect((await me.json()).user.email).toBe(result.email);
  });

  it("拒绝重复注册和错误密码，正确密码可以重新登录", async () => {
    const registered = await registerAccount();
    const duplicate = await api.request("/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        displayName: "另一个名字",
        email: registered.email.toUpperCase(),
        password: registered.password,
      }),
    });
    expect(duplicate.status).toBe(403);

    const wrong = await api.request("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: registered.email, password: "wrong-password" }),
    });
    expect(wrong.status).toBe(401);

    const correct = await api.request("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: registered.email.toUpperCase(), password: registered.password }),
    });
    expect(correct.status).toBe(200);
    expect(correct.headers.get("set-cookie")).toContain("dw_account=");
  });
});

describe("管理员注册邀请码", () => {
  it("没有有效邀请码的新用户不能注册", async () => {
    sequence += 1;
    const withoutCode = await api.request("/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        displayName: "没有邀请码",
        email: `no-code-${sequence}@deepwe.test`,
        password: "no-code-password",
      }),
    });
    expect(withoutCode.status).toBe(403);

    const invalidCode = await api.request("/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        displayName: "错误邀请码",
        email: `bad-code-${sequence}@deepwe.test`,
        password: "bad-code-password",
        registrationCode: "AAAA-BBBB",
      }),
    });
    expect(invalidCode.status).toBe(403);
  });

  it("管理员生成的邀请码只能成功注册一次", async () => {
    const code = await createRegistrationCode("一次性测试");
    sequence += 1;
    const first = await api.request("/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        displayName: "第一位受邀者",
        email: `first-invite-${sequence}@deepwe.test`,
        password: "first-invite-password",
        registrationCode: code,
      }),
    });
    expect(first.status).toBe(201);

    sequence += 1;
    const reused = await api.request("/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        displayName: "第二位尝试者",
        email: `second-invite-${sequence}@deepwe.test`,
        password: "second-invite-password",
        registrationCode: code,
      }),
    });
    expect(reused.status).toBe(403);
  });

  it("普通用户不能生成邀请码，管理员可以撤回未使用的邀请码", async () => {
    const ordinary = await registerAccount("普通用户");
    const forbidden = await api.request("/admin/registration-invites", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: ordinary.cookie },
      body: JSON.stringify({ note: "越权尝试" }),
    });
    expect(forbidden.status).toBe(403);

    const code = await createRegistrationCode("准备撤回");
    const list = await api.request("/admin/registration-invites", {
      headers: { Cookie: adminCookie },
    });
    const invite = (await list.json()).invites.find((item: { code: string }) => item.code === code);
    const revoked = await api.request(`/admin/registration-invites/${invite.id}`, {
      method: "DELETE",
      headers: { Cookie: adminCookie },
    });
    expect(revoked.status).toBe(200);
    const listAfterRevoke = await api.request("/admin/registration-invites", {
      headers: { Cookie: adminCookie },
    });
    expect((await listAfterRevoke.json()).invites).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ code })])
    );

    sequence += 1;
    const registration = await api.request("/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        displayName: "撤回后尝试",
        email: `revoked-${sequence}@deepwe.test`,
        password: "revoked-code-password",
        registrationCode: code,
      }),
    });
    expect(registration.status).toBe(403);
  });
});

describe("伴侣连接与双人空间", () => {
  async function createPartnerCode(ownerCookie: string): Promise<string> {
    const response = await api.request("/partner/invites", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: ownerCookie },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(201);
    return (await response.json()).invite.code;
  }

  async function approvePendingBinding(ownerCookie: string): Promise<void> {
    const overview = await api.request("/partner", { headers: { Cookie: ownerCookie } });
    const request = (await overview.json()).bindingRequest;
    expect(request?.direction).toBe("incoming");
    const approved = await api.request(`/partner/invites/${request.id}/approve`, {
      method: "POST",
      headers: { Cookie: ownerCookie },
    });
    expect(approved.status).toBe(200);
  }

  it("伴侣邀请可以直接完成注册和连接，并且只能使用一次", async () => {
    const owner = await registerAccount("伴侣邀请发起者");
    const code = await createPartnerCode(owner.cookie);
    sequence += 1;
    const joined = await api.request("/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        displayName: "通过伴侣邀请加入",
        email: `partner-joined-${sequence}@deepwe.test`,
        password: "partner-joined-password",
        registrationCode: code,
      }),
    });
    expect(joined.status).toBe(201);
    await approvePendingBinding(owner.cookie);

    const ownerOverview = await api.request("/partner", { headers: { Cookie: owner.cookie } });
    expect((await ownerOverview.json()).connection.partner.displayName).toBe("通过伴侣邀请加入");

    sequence += 1;
    const reused = await api.request("/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        displayName: "重复使用者",
        email: `partner-reused-${sequence}@deepwe.test`,
        password: "partner-reused-password",
        registrationCode: code,
      }),
    });
    expect(reused.status).toBe(403);

    const thirdInvite = await api.request("/partner/invites", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: owner.cookie },
      body: JSON.stringify({}),
    });
    expect(thirdInvite.status).toBe(409);
  });

  it("已注册用户可以连接和结束连接，待回应的共同复盘会同时撤回", async () => {
    const a = await registerAccount("已注册伴侣 A");
    const b = await registerAccount("已注册伴侣 B");
    const code = await createPartnerCode(a.cookie);
    const accepted = await api.request("/partner/invites/accept", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: b.cookie },
      body: JSON.stringify({ code }),
    });
    expect(accepted.status).toBe(200);
    await approvePendingBinding(a.cookie);

    const event = db.createEvent("等待伴侣回应的复盘", a.body.user.id);
    db.upsertPerspective(event.id, "a", "A 的私密原文");
    db.setSummary(event.id, "a", JSON.stringify({
      observation: "一次虚构分歧",
      feelings: ["失落"],
      needs: ["沟通"],
      request: "希望说明情况",
    }));
    db.confirmSummary(event.id, "a");
    db.transition(event.id, "a_guiding", "a_summary");
    db.transition(event.id, "a_summary", "waiting_b");
    expect(db.targetActivePartnerForEvent(event.id, a.body.user.id)).toBe(b.body.user.id);

    const ended = await api.request("/partner/connection", {
      method: "DELETE",
      headers: { Cookie: a.cookie },
    });
    expect(ended.status).toBe(200);
    expect(db.getEvent(event.id)?.state).toBe("cancelled");
    expect(db.getEvent(event.id)?.partner_target_user_id).toBeNull();
    const overview = await api.request("/partner", { headers: { Cookie: b.cookie } });
    expect((await overview.json()).connection.status).toBe("disconnecting");
  });

  it("共同空间只在双方确认后形成长期内容，支持修改和拒绝", async () => {
    const a = await registerAccount("共同空间 A");
    const b = await registerAccount("共同空间 B");
    const outsider = await registerAccount("共同空间无关用户");
    const code = await createPartnerCode(a.cookie);
    const connected = await api.request("/partner/invites/accept", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: b.cookie },
      body: JSON.stringify({ code }),
    });
    expect(connected.status).toBe(200);
    await approvePendingBinding(a.cookie);

    const outsiderSpace = await api.request("/partner/space", {
      headers: { Cookie: outsider.cookie },
    });
    expect(outsiderSpace.status).toBe(409);

    const proposed = await api.request("/partner/space/proposals", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: a.cookie },
      body: JSON.stringify({
        category: "communication_method",
        content: "情绪很高时，一次只说一件事",
      }),
    });
    expect(proposed.status).toBe(201);
    const proposalId = (await proposed.json()).proposal.id;

    const bSpaceBefore = await api.request("/partner/space", { headers: { Cookie: b.cookie } });
    expect((await bSpaceBefore.json()).space.proposals[0]).toEqual(
      expect.objectContaining({
        id: proposalId,
        proposedByMe: false,
        myConfirmed: false,
        partnerConfirmed: true,
      })
    );

    const blockedRevision = await api.request(`/partner/space/proposals/${proposalId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: b.cookie },
      body: JSON.stringify({ content: "情绪很高时，先确认只讨论当下这一件事" }),
    });
    expect(blockedRevision.status).toBe(409);
    const revised = await api.request(`/partner/space/proposals/${proposalId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: a.cookie },
      body: JSON.stringify({ content: "情绪很高时，先确认只讨论当下这一件事" }),
    });
    expect(revised.status).toBe(200);
    expect((await revised.json()).space.proposals[0]).toEqual(
      expect.objectContaining({ myConfirmed: true, partnerConfirmed: false, updatedByMe: true })
    );

    const confirmed = await api.request(`/partner/space/proposals/${proposalId}/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: b.cookie },
      body: JSON.stringify({ expectedVersion: 2 }),
    });
    expect(confirmed.status).toBe(200);
    expect((await confirmed.json()).space).toEqual(
      expect.objectContaining({
        proposals: [],
        memories: [
          expect.objectContaining({
            category: "communication_method",
            content: "情绪很高时，先确认只讨论当下这一件事",
          }),
        ],
      })
    );

    const second = await api.request("/partner/space/proposals", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: b.cookie },
      body: JSON.stringify({ category: "support_method", content: "先听完，不马上给建议" }),
    });
    const secondId = (await second.json()).proposal.id;
    const rejected = await api.request(`/partner/space/proposals/${secondId}/reject`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: a.cookie },
      body: JSON.stringify({ reason: "我想把说法再具体一点" }),
    });
    expect(rejected.status).toBe(200);
    expect((await rejected.json()).space.proposals[0]).toEqual(
      expect.objectContaining({ status: "rejected", rejectionReason: "我想把说法再具体一点" })
    );

    const ended = await api.request("/partner/connection", {
      method: "DELETE",
      headers: { Cookie: b.cookie },
    });
    expect(ended.status).toBe(200);
    expect((await api.request("/partner/space", { headers: { Cookie: a.cookie } })).status).toBe(409);
  });

  it("每次共同复盘都要单独接受，其他账号不能绕过定向邀请", async () => {
    const a = await registerAccount("复盘发起伴侣");
    const b = await registerAccount("复盘受邀伴侣");
    const outsider = await registerAccount("无关账号");
    const code = await createPartnerCode(a.cookie);
    const connected = await api.request("/partner/invites/accept", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: b.cookie },
      body: JSON.stringify({ code }),
    });
    expect(connected.status).toBe(200);
    await approvePendingBinding(a.cookie);

    const event = db.createEvent("只向伴侣发出的复盘", a.body.user.id);
    db.upsertPerspective(event.id, "a", "A 只有自己能看到的完整讲述");
    db.setSummary(event.id, "a", JSON.stringify({
      observation: "一次虚构分歧",
      feelings: ["难过"],
      needs: ["理解"],
      request: "希望一起复盘",
    }));
    db.transition(event.id, "a_guiding", "a_summary");

    const confirmed = await api.request(`/events/${event.id}/summary/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: a.cookie },
      body: JSON.stringify({}),
    });
    expect(confirmed.status).toBe(200);
    expect((await confirmed.json()).partnerTargeted).toBe(true);

    const pending = await api.request("/partner", { headers: { Cookie: b.cookie } });
    expect((await pending.json()).eventInvites).toEqual([
      expect.objectContaining({ id: event.id, title: "只向伴侣发出的复盘" }),
    ]);

    const privateBeforeAccept = await api.request(`/events/${event.id}`, {
      headers: { Cookie: b.cookie },
    });
    expect(privateBeforeAccept.status).toBe(404);
    expect(Object.keys(await privateBeforeAccept.json())).toEqual(["error"]);

    const bypass = await api.request("/events/join", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: outsider.cookie },
      body: JSON.stringify({ code: event.code }),
    });
    expect(bypass.status).toBe(409);

    const accepted = await api.request(`/partner/event-invites/${event.id}/accept`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: b.cookie },
      body: JSON.stringify({}),
    });
    expect(accepted.status).toBe(200);
    const bView = await api.request(`/events/${event.id}`, { headers: { Cookie: b.cookie } });
    const body = await bView.json();
    expect(body.role).toBe("b");
    expect(body.guideMessages).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ content: "A 只有自己能看到的完整讲述" })])
    );
  });
});

describe("密码安全与找回", () => {
  it("用户可以验证当前密码后修改密码，并让旧会话失效", async () => {
    const account = await registerAccount("改密用户");
    const changed = await api.request("/auth/change-password", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: account.cookie },
      body: JSON.stringify({
        currentPassword: account.password,
        newPassword: "changed-password-123",
      }),
    });
    expect(changed.status).toBe(200);

    const oldLogin = await api.request("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: account.email, password: account.password }),
    });
    expect(oldLogin.status).toBe(401);
    const newLogin = await api.request("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: account.email, password: "changed-password-123" }),
    });
    expect(newLogin.status).toBe(200);
  });

  it("管理员可以生成一次性重置码，使用后旧密码和重置码都失效", async () => {
    const account = await registerAccount("忘记密码用户");
    const generated = await api.request("/admin/password-resets", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: adminCookie },
      body: JSON.stringify({ userId: account.body.user.id }),
    });
    expect(generated.status).toBe(201);
    const code = (await generated.json()).reset.code;

    const reset = await api.request("/auth/reset-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: account.email, code, newPassword: "reset-password-123" }),
    });
    expect(reset.status).toBe(200);
    const reused = await api.request("/auth/reset-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: account.email, code, newPassword: "another-password-123" }),
    });
    expect(reused.status).toBe(403);
  });
});

describe("账号与私密事件归属", () => {
  it("未登录不能创建，登录后事件归属账号，退出后旧令牌不能绕过登录", async () => {
    const anonymous = await api.request("/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "未登录测试", rawText: "虚构内容" }),
    });
    expect(anonymous.status).toBe(401);

    const account = await registerAccount();
    const created = await api.request("/events", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: account.cookie },
      body: JSON.stringify({ title: "账号归属测试", rawText: "虚构的普通关系分歧" }),
    });
    expect(created.status).toBe(202);
    const createdBody = await created.json();
    const event = db.getEvent(createdBody.id)!;
    expect(event.a_user_id).toBe(account.body.user.id);

    const accountEvent = await api.request(`/events/${event.id}`, {
      headers: { Cookie: account.cookie },
    });
    expect((await accountEvent.json()).role).toBe("a");

    const logout = await api.request("/auth/logout", {
      method: "POST",
      headers: { Cookie: account.cookie },
    });
    expect(logout.status).toBe(200);
    const afterLogout = await api.request(`/events/${event.id}`, {
      headers: { Cookie: `${account.cookie}; dw_${event.id}=${event.a_token}` },
    });
    expect(afterLogout.status).toBe(404);
    expect(Object.keys(await afterLogout.json())).toEqual(["error"]);
  });

  it("首次登录会认领当前浏览器中的旧版潜谈", async () => {
    const legacy = db.createEvent("旧版潜谈");
    sequence += 1;
    const email = `legacy-${sequence}@deepwe.test`;
    const response = await api.request("/auth/register", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `dw_${legacy.id}=${legacy.aToken}`,
      },
      body: JSON.stringify({
        displayName: "旧版用户",
        email,
        password: "legacy-password-123",
        registrationCode: await createRegistrationCode("旧版用户迁移"),
      }),
    });
    const body = await response.json();
    expect(response.status).toBe(201);
    expect(db.getEvent(legacy.id)?.a_user_id).toBe(body.user.id);

    const accountCookie = String(response.headers.get("set-cookie")).split(";")[0];
    const list = await api.request("/events", { headers: { Cookie: accountCookie } });
    expect((await list.json()).events).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: legacy.id, role: "a" })])
    );
  });

  it("发起者不能加入自己的邀请，伴侣加入后各自账号保持隔离", async () => {
    const a = await registerAccount("A 用户");
    const b = await registerAccount("B 用户");
    const event = db.createEvent("双人账号测试", a.body.user.id);
    db.transition(event.id, "a_guiding", "a_summary");
    db.transition(event.id, "a_summary", "waiting_b");

    const selfJoin = await api.request("/events/join", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: a.cookie },
      body: JSON.stringify({ code: event.code }),
    });
    expect(selfJoin.status).toBe(409);

    const partnerJoin = await api.request("/events/join", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: b.cookie },
      body: JSON.stringify({ code: event.code }),
    });
    expect(partnerJoin.status).toBe(409);
    expect(db.getEvent(event.id)?.b_user_id).toBeNull();

    const aView = await api.request(`/events/${event.id}`, { headers: { Cookie: a.cookie } });
    const bView = await api.request(`/events/${event.id}`, { headers: { Cookie: b.cookie } });
    expect((await aView.json()).role).toBe("a");
    expect(bView.status).toBe(404);
    expect(Object.keys(await bView.json())).toEqual(["error"]);
  });

  it("用户可以重命名对话，导出时不会包含对方私密潜谈", async () => {
    const account = await registerAccount("导出测试用户");
    const event = db.createEvent("旧名称", account.body.user.id);
    db.addGuideMessage(event.id, "a", "a", "本人可以导出的内容");
    db.addGuideMessage(event.id, "b", "b", "对方绝对私密的内容");

    const renamed = await api.request(`/events/${event.id}/title`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: account.cookie },
      body: JSON.stringify({ title: "新的对话名称" }),
    });
    expect(renamed.status).toBe(200);
    expect(db.getEvent(event.id)?.title).toBe("新的对话名称");

    const exported = await api.request("/account/export", {
      headers: { Cookie: account.cookie },
    });
    expect(exported.status).toBe(200);
    const text = JSON.stringify(await exported.json());
    expect(text).toContain("本人可以导出的内容");
    expect(text).not.toContain("对方绝对私密的内容");
  });

  it("注销时删除本人私密内容，但保留对方私密内容和共同结果", async () => {
    const owner = await registerAccount("准备注销的用户");
    const partner = await registerAccount("保留数据的对方");
    const event = db.createEvent("共同复盘注销测试", owner.body.user.id);
    db.transition(event.id, "a_guiding", "a_summary");
    db.transition(event.id, "a_summary", "waiting_b");
    expect(db.setBParticipant(event.id, "partner-token", partner.body.user.id)).toBe(true);
    db.transition(event.id, "waiting_b", "b_guiding");
    db.addGuideMessage(event.id, "a", "a", "注销者的私密内容");
    db.addGuideMessage(event.id, "b", "b", "对方应当保留的私密内容");
    db.upsertPerspective(event.id, "a", "注销者的个人总结来源");
    db.upsertPerspective(event.id, "b", "对方的个人总结来源");
    db.upsertMerged(event.id, JSON.stringify({ shared: "双方共同结果" }));

    const deleted = await api.request("/account", {
      method: "DELETE",
      headers: { "Content-Type": "application/json", Cookie: owner.cookie },
      body: JSON.stringify({ password: owner.password }),
    });
    expect(deleted.status).toBe(200);
    expect(db.getUserById(owner.body.user.id)).toBeUndefined();
    expect(db.getUserById(partner.body.user.id)).toBeDefined();
    expect(db.getGuideMessages(event.id, "a")).toEqual([]);
    expect(db.getGuideMessages(event.id, "b")).toEqual([
      expect.objectContaining({ content: "对方应当保留的私密内容" }),
    ]);
    expect(db.getPerspective(event.id, "a")).toBeUndefined();
    expect(db.getPerspective(event.id, "b")).toBeDefined();
    expect(db.getMerged(event.id)).toBeDefined();
  });
});

describe("用户删除历史潜谈", () => {
  it("共同复盘需要双方确认后才会永久删除", async () => {
    const a = await registerAccount("删除测试 A");
    const b = await registerAccount("删除测试 B");
    const event = db.createEvent("需要删除的潜谈", a.body.user.id);
    db.upsertPerspective(event.id, "a", "虚构原始内容");
    db.setSummary(
      event.id,
      "a",
      JSON.stringify({ observation: "虚构摘要", feelings: [], needs: [], request: "" })
    );
    db.addGuideMessage(event.id, "a", "a", "虚构消息");
    db.saveGuideSession(event.id, "a", "story", JSON.stringify({ context: "虚构背景" }));
    db.upsertMerged(event.id, JSON.stringify({ event_summary: "虚构共同结果" }));
    db.setChoice(event.id, "a", "虚构选择");
    const job = db.enqueueAiJob(event.id, "summary", "a");
    db.transition(event.id, "a_guiding", "a_summary");
    db.transition(event.id, "a_summary", "waiting_b");
    expect(db.setBParticipant(event.id, db.randomToken(), b.body.user.id)).toBe(true);

    const response = await api.request(`/events/${event.id}`, {
      method: "DELETE",
      headers: { Cookie: b.cookie },
    });

    expect(response.status).toBe(200);
    expect((await response.json()).hiddenOnly).toBe(true);
    expect(db.getEvent(event.id)).toBeDefined();

    const firstRequest = await api.request(`/events/${event.id}/deletion-request`, {
      method: "POST", headers: { Cookie: b.cookie },
    });
    expect((await firstRequest.json()).status).toBe("pending");
    expect(db.getEvent(event.id)).toBeDefined();
    const secondRequest = await api.request(`/events/${event.id}/deletion-request`, {
      method: "POST", headers: { Cookie: a.cookie },
    });
    expect((await secondRequest.json()).status).toBe("deleted");
    expect(db.getEvent(event.id)).toBeUndefined();
    expect(db.getPerspective(event.id, "a")).toBeUndefined();
    expect(db.getGuideMessages(event.id, "a")).toEqual([]);
    expect(db.getGuideSession(event.id, "a")).toBeUndefined();
    expect(db.getMerged(event.id)).toBeUndefined();
    expect(db.getAgreement(event.id)).toBeUndefined();
    expect(db.getAiJob(job.id)).toBeUndefined();
    expect(db.listEventsForUser(a.body.user.id)).toEqual([]);
    expect(db.listEventsForUser(b.body.user.id)).toEqual([]);
  });

  it("非参与者不能删除别人的潜谈", async () => {
    const owner = await registerAccount("被保护的用户");
    const outsider = await registerAccount("无关用户");
    const event = db.createEvent("不能越权删除", owner.body.user.id);

    const response = await api.request(`/events/${event.id}`, {
      method: "DELETE",
      headers: { Cookie: outsider.cookie },
    });

    expect(response.status).toBe(403);
    expect(db.getEvent(event.id)).toBeTruthy();
  });
});
