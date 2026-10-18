import { createHash, randomUUID } from "node:crypto";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import api from "./routes";
import { security } from "./security";
import * as db from "./db";
import { hashPassword } from "./auth";

function account(name: string) {
  const user = db.createUser(`${randomUUID()}@privacy.test`, name, "hash", "salt", false);
  const token = randomUUID();
  db.createAccountSession(user.id, createHash("sha256").update(token).digest("hex"), Date.now() + 60000);
  return { user, cookie: `dw_account=${token}` };
}

describe("网页安全边界", () => {
  it("A/B账号只能读本人的消息，第三个账号和旧角色cookie不能绕过", async () => {
    const a = account("A"), b = account("B"), outsider = account("第三人");
    const event = db.createEvent("不能公开的标题", a.user.id);
    db.db.prepare("UPDATE events SET b_user_id = ?, risk_level = 'violence' WHERE id = ?").run(b.user.id, event.id);
    db.addGuideMessage(event.id, "a", "a", "A的私密故事");
    db.addGuideMessage(event.id, "b", "b", "B的私密故事");
    for (const [cookie, own, other] of [[a.cookie, "A的私密故事", "B的私密故事"], [b.cookie, "B的私密故事", "A的私密故事"]]) {
      const response = await api.request(`/events/${event.id}`, { headers: { Cookie: cookie } });
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).toContain(own);
      expect(text).not.toContain(other);
      expect(response.headers.get("Cache-Control")).toContain("no-store");
    }
    for (const cookie of ["", outsider.cookie, `dw_${event.id}=${event.aToken}`]) {
      const response = await api.request(`/events/${event.id}`, { headers: { Cookie: cookie } });
      expect(response.status).toBe(404);
      expect(Object.keys(await response.json())).toEqual(["error"]);
    }
    for (const path of ["/admin/users", "/admin/registration-invites", "/account/export", "/events", "/partner", "/partner/space"]) {
      const response = await api.request(path);
      expect(response.status).toBe(401);
      expect(response.headers.get("Cache-Control")).toContain("no-store");
    }
    expect((await api.request("/admin/users", { headers: { Cookie: outsider.cookie } })).status).toBe(403);
  });

  it("伴侣对象只返回昵称和ID，不包含邮箱、权限、密码或会话凭证", () => {
    const a = account("本人"), b = account("伴侣");
    const event = db.createEvent("隐私检查", a.user.id);
    db.db.prepare("UPDATE events SET partner_target_user_id = ? WHERE id = ?").run(b.user.id, event.id);
    expect(db.getPartnerTarget(event.id)).toEqual({ id: b.user.id, displayName: "伴侣" });
    expect(Object.keys(db.publicUser(a.user))).not.toContain("password_hash");
  });

  it("外站写请求和HTML表单被拒；本站请求正常", async () => {
    const app = new Hono().use("*", security).post("/write", c => c.json({ ok: true }));
    expect((await app.request("/write", { method: "POST", headers: { Origin: "https://evil.test" } })).status).toBe(403);
    expect((await app.request("/write", { method: "POST", headers: { "Sec-Fetch-Site": "cross-site" } })).status).toBe(403);
    expect((await app.request("/write", { method: "POST", headers: { "Content-Type": "text/plain" }, body: "{}" })).status).toBe(415);
    expect((await app.request("/write", { method: "POST", headers: { Origin: "https://s2fslv06rel2qvptljhke.apigateway-cn-beijing.volceapi.com", "Content-Type": "application/json" }, body: "{}" })).status).toBe(200);
  });

  it("登录限流不能通过伪造转发IP或改变邮箱大小写绕过", async () => {
    const app = new Hono().use("*", security).post("/auth/login", c => c.json({ ok: true }));
    const email = `${randomUUID()}@rate.test`;
    for (let i = 0; i < 20; i++) {
      const response = await app.request("/auth/login", { method: "POST", headers: { "Content-Type": "application/json", "X-Forwarded-For": `1.2.3.${i}` }, body: JSON.stringify({ email: i % 2 ? email.toUpperCase() : email }) });
      expect(response.status).toBe(200);
    }
    const blocked = await app.request("/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email }) });
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("Retry-After")).toBeTruthy();
  });

  it("超大请求在解析和鉴权计算之前被拒绝", async () => {
    const response = await api.request("/auth/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "x@privacy.test", password: "a".repeat(256 * 1024) }),
    });
    expect(response.status).toBe(413);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
  });

  it("生产登录凭证只通过安全HttpOnly cookie传递，注册不能区分不存在的邮箱", async () => {
    const email = `${randomUUID()}@privacy.test`, password = "security-test-password";
    const hashed = await hashPassword(password);
    db.createUser(email, "测试", hashed.passwordHash, hashed.passwordSalt, false);
    vi.stubEnv("NODE_ENV", "production");
    try {
      const login = await api.request("/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) });
      expect(login.status).toBe(200);
      expect(login.headers.get("Set-Cookie")).toContain("Secure");
      expect(login.headers.get("Set-Cookie")).toContain("HttpOnly");
      const replies = [];
      for (const target of [email, `${randomUUID()}@privacy.test`]) {
        const response = await api.request("/auth/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: target, password, displayName: "测试", registrationCode: "invalid-test-code" }) });
        replies.push({ status: response.status, body: await response.json() });
      }
      expect(replies[0]).toEqual(replies[1]);
    } finally { vi.unstubAllEnvs(); }
  });
});
