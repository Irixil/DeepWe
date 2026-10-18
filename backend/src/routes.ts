import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import { setCookie } from "hono/cookie";
import * as db from "./db.js";
import {
  claimLegacyEventsFromCookies,
  endAccountSession,
  getCurrentUser,
  getSessionToken,
  getSessionRole,
  hashPassword,
  requireAccount,
  requireAdmin,
  requireParticipant,
  requireRole,
  startAccountSession,
  verifyPassword,
} from "./auth.js";
import {
  emptyStoryMap,
  guideProgress,
  type StoryMap,
  type MergedUnderstanding,
  type NvcSummary,
} from "./ai.js";
import { wakeAiWorker } from "./ai-worker.js";
import { persistDatabaseIfChanged } from "./persistence.js";
import { security } from "./security.js";
import * as privateCore from "./private-core.js";
import { wakePrivateWorker } from "./private-ai-worker.js";
import * as privateMemory from "./private-memory.js";

const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/",
  maxAge: 60 * 60 * 24 * 30,
};

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const ANALYTICS_EVENTS = new Set([
  "app_opened","screen_viewed","screen_left","registration_completed","login_completed",
  "event_created","guide_started","guide_stage_viewed","summary_requested","summary_confirmed","guide_ended",
  "partner_invite_created","partner_invite_accepted","partner_event_invite_accepted","partner_event_invite_later",
  "shared_understanding_confirmed","agreement_submitted","review_submitted","ai_stopped","ai_retried",
  "message_feedback_submitted","core_outcome_submitted","request_failed","conversation_created","conversation_message_sent",
  "conversation_share_prepared","conversation_share_confirmed","conversation_deleted",
]);
const ANALYTICS_SCREENS = new Set(["auth","home","couple","records","me","event","conversation","admin"]);
const ANALYTICS_VALUES = new Set(["lighter","same","worse","unclear","skipped","network_error","client_error","server_error","理解错了","问得太机械","我不想回答这个","换个方式问","没有被理解","问题太多","建议没帮助","等待太久","暂时不想继续","auth","events","partner","account","admin","conversation"]);
// Closed list of current page tabs, guide stages and event states emitted by the frontend.
const ANALYTICS_STEPS = new Set([
  "home","couple","records","me","conversation","event",
  "story","reflection","checkin","review",
  "a_expressing","a_summary","waiting_b","b_expressing","b_summary","ready_to_merge",
  "merged","agreement_proposed","done","completed","declined","cancelled","closed","safety_exit","sharing_revoked",
]);
const ANALYTICS_SESSION_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function accountView(user:db.UserRow) {
  const isOwner=!!process.env.DEEPWE_OWNER_USER_ID?.trim()&&user.id===process.env.DEEPWE_OWNER_USER_ID.trim();
  const details=user as db.UserRow&{analytics_enabled?:number;analytics_notice_seen?:number};
  return {...db.publicUser(user),isOwner,isAdmin:isOwner,analyticsEnabled:!!details.analytics_enabled,analyticsNoticeSeen:!!details.analytics_notice_seen};
}

function registrationInviteRequired(): boolean {
  const configured = process.env.DEEPWE_REGISTRATION_INVITE_REQUIRED?.trim().toLowerCase();
  if (configured === "true") return true;
  if (configured === "false") return false;
  return db.countUsers() > 0 || process.env.NODE_ENV === "production";
}

function setRoleCookie(c: Context, eventId: string, token: string): void {
  setCookie(c, `dw_${eventId}`, token, COOKIE_OPTS);
}

type RiskKind = "none" | "violence" | "self_harm" | "harm_others" | "mental_health";

function stripExplicitRiskNegations(text: string): string {
  const noListedRisk = /(?:没有|没|并未|并不|从未|从来没有|不曾)(?:自杀|自残|伤害自己|家暴|暴力|幻听|幻觉|被害妄想|躁狂)(?:(?:、|和|以及)(?:自杀|自残|伤害自己|家暴|暴力|幻听|幻觉|被害妄想|躁狂))+/g;
  const noIntent = /(?:没有|没|并未|并不|从未|从来没有|不曾)(?:想|想过|打算|准备|有过)?(?:自杀|自残|伤害自己|结束生命|杀了他|杀了她|杀了你|伤害你|伤害他|伤害她)/g;
  const noExperience = /(?:没有|没|并未|从未|从来没有|不曾|不存在)(?:发生过|经历过|遭遇过|受到|被|有过)?(?:家暴|暴力|殴打|掐脖子|强迫性行为|性侵|虐待|跟踪|恐吓|威胁|砸东西|限制出门|关起来|控制钱)/g;
  const noSymptom = /(?:没有|没|并未|并不|从未|从来没有|不曾)(?:出现|发生|有过)?(?:幻听|幻觉|被害妄想|躁狂)/g;
  const deniedLabel = /(?:不是|不存在)(?:家暴|暴力|自杀|自残|幻听|幻觉|被害妄想|躁狂)/g;
  return text.replace(noListedRisk, "").replace(noIntent, "").replace(noExperience, "").replace(noSymptom, "").replace(deniedLabel, "");
}

function riskLevel(text: string): RiskKind {
  const withoutNegatedRisk = stripExplicitRiskNegations(text);
  if (/(自杀|自残|不想活|活不下去|伤害自己|结束生命)/.test(withoutNegatedRisk)) return "self_harm";
  if (/(杀了他|杀了她|杀了你|同归于尽|伤害你|伤害他|伤害她)/.test(withoutNegatedRisk)) return "harm_others";
  if (/(家暴|殴打|掐脖子|强迫性行为|性侵|虐待|跟踪|恐吓|威胁|砸东西|限制出门|关起来|控制钱|不让我见朋友|暴力)/.test(withoutNegatedRisk)) return "violence";
  if (/(幻听|幻觉|被害妄想|躁狂|精神崩溃|严重抑郁|持续失眠.{0,6}(?:无法生活|无法工作))/.test(withoutNegatedRisk)) return "mental_health";
  return "none";
}

function normalizeEmail(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

function validateAccountInput(
  email: string,
  password: string,
  displayName?: string
): string | null {
  if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return "请输入有效的邮箱地址";
  }
  if (password.length < 8) return "密码至少需要 8 位";
  if (password.length > 128) return "密码不能超过 128 位";
  if (displayName !== undefined && (!displayName || displayName.length > 30)) {
    return "昵称需要填写，并且不能超过 30 个字";
  }
  return null;
}

function storyFor(eventId: string, role: "a" | "b"): StoryMap {
  const session = db.getGuideSession(eventId, role);
  if (!session?.story_map) return emptyStoryMap();
  try {
    const parsed = JSON.parse(session.story_map) as Partial<StoryMap>;
    const empty = emptyStoryMap();
    return {
      context: typeof parsed.context === "string" ? parsed.context : empty.context,
      timeline: Array.isArray(parsed.timeline) ? parsed.timeline.map(String) : empty.timeline,
      words_actions: Array.isArray(parsed.words_actions)
        ? parsed.words_actions.map(String)
        : empty.words_actions,
      outcome: typeof parsed.outcome === "string" ? parsed.outcome : empty.outcome,
      feelings: Array.isArray(parsed.feelings) ? parsed.feelings.map(String) : empty.feelings,
      impact: typeof parsed.impact === "string" ? parsed.impact : empty.impact,
      needs: Array.isArray(parsed.needs) ? parsed.needs.map(String) : empty.needs,
      expectations:
        typeof parsed.expectations === "string" ? parsed.expectations : empty.expectations,
      facts: Array.isArray(parsed.facts) ? parsed.facts.map(String) : empty.facts,
      interpretations: Array.isArray(parsed.interpretations)
        ? parsed.interpretations.map(String)
        : empty.interpretations,
      unknowns: Array.isArray(parsed.unknowns) ? parsed.unknowns.map(String) : empty.unknowns,
    };
  } catch {
    return emptyStoryMap();
  }
}

export const api = new Hono();
api.use("*", bodyLimit({ maxSize: 256 * 1024, onError: (c) => {
  c.header("Cache-Control", "private, no-store, max-age=0");
  return c.json({ error: "内容过长，请分段发送" }, 413);
} }));
api.use("*", security);
api.use("*", async (c,next) => {
  if(!["POST","PUT","PATCH","DELETE"].includes(c.req.method)||!c.req.raw.body) return next();
  const raw=await c.req.raw.clone().text();
  if(!raw.trim()) return next();
  let body:unknown;
  try { body=JSON.parse(raw); } catch { return c.json({error:"请求正文必须是有效 JSON 对象"},400); }
  if(!body||typeof body!=="object"||Array.isArray(body)) return c.json({error:"请求正文必须是 JSON 对象"},400);
  return next();
});
api.onError((_error, c) => c.json({ error: "服务暂时不可用，请稍后再试" }, 500));

// 允许前端跨域（本地联调；部署后前端通过 /api 同源代理，可去掉 CORS）
if (process.env.NODE_ENV !== "production") {
  api.use("*", cors({ origin: ["http://localhost:3000", "http://localhost:3001", "http://127.0.0.1:3000", "http://127.0.0.1:3001"], credentials: true }));
}
// 写请求返回成功前，把本机 SQLite 的一致性快照同步到持久存储。
// 只读请求没有数据库变化时会立即跳过，不增加对象存储请求。
api.use("*", async (_c, next) => {
  await next();
  await persistDatabaseIfChanged();
});

api.get("/health", (c) =>
  c.json({
    ok: true,
    version: "professional-v2-experiment",
    humanReviewed: false,
    ownerConfigured: !!process.env.DEEPWE_OWNER_USER_ID?.trim() && !!db.getUserById(process.env.DEEPWE_OWNER_USER_ID.trim()),
  })
);

// ---------- 账号 ----------

api.get("/auth/registration-status", (c) =>
  c.json({ inviteRequired: registrationInviteRequired() })
);

api.post("/auth/register", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const email = normalizeEmail(body.email);
  const password = String(body.password ?? "");
  const displayName = String(body.displayName ?? "").trim();
  const registrationCode = String(body.registrationCode ?? "").trim();
  const validationError = validateAccountInput(email, password, displayName);
  if (validationError) return c.json({ error: validationError }, 400);

  const isFirstAccount = db.countUsers() === 0;
  const inviteRequired = registrationInviteRequired();
  if (!isFirstAccount && inviteRequired && !registrationCode) {
    return c.json({ error: "请输入邀请码" }, 403);
  }
  const { passwordHash, passwordSalt } = await hashPassword(password);
  // 与无效邀请码采用相同响应，并保留相同密码计算，减少账号探测。
  if (db.getUserByEmail(email)) return c.json({ error: "无法注册，请检查邀请码和填写信息；已有账号请直接登录" }, 403);
  let user: db.UserRow;
  try {
    if (isFirstAccount) {
      user = db.createUser(email, displayName, passwordHash, passwordSalt, false);
    } else if (!registrationCode) {
      user = db.createUser(email, displayName, passwordHash, passwordSalt, false);
    } else {
      const registrationInvitedUser = db.createUserWithRegistrationInvite(
        registrationCode,
        email,
        displayName,
        passwordHash,
        passwordSalt
      );
      const invitedUser =
        registrationInvitedUser ??
        db.createUserWithPartnerInvite(
          registrationCode,
          email,
          displayName,
          passwordHash,
          passwordSalt
        );
      if (!invitedUser) return c.json({ error: "无法注册，请检查邀请码和填写信息；已有账号请直接登录" }, 403);
      user = invitedUser;
    }
  } catch {
    return c.json({ error: "暂时无法创建账号，请检查邀请码后重试" }, 409);
  }
  claimLegacyEventsFromCookies(c, user.id);
  startAccountSession(c, user.id);
  return c.json({ user: accountView(user) }, 201);
});

api.post("/auth/login", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const email = normalizeEmail(body.email);
  const password = String(body.password ?? "");
  if (!email || !password) return c.json({ error: "请输入邮箱和密码" }, 400);

  const user = db.getUserByEmail(email);
  // 即使邮箱不存在也执行一次完整密码计算，减少通过响应时间探测账号的风险。
  const valid = await verifyPassword(
    password,
    user?.password_hash ?? "00".repeat(64),
    user?.password_salt ?? "00".repeat(16)
  );
  if (!user || !valid) return c.json({ error: "邮箱或密码不正确" }, 401);

  claimLegacyEventsFromCookies(c, user.id);
  startAccountSession(c, user.id);
  return c.json({ user: accountView(user) });
});

api.get("/auth/me", (c) => {
  const user = getCurrentUser(c);
  return c.json({ user: user ? accountView(user) : null });
});

api.post("/auth/logout", (c) => {
  endAccountSession(c);
  return c.json({ ok: true });
});

api.post("/auth/change-password", async (c) => {
  const account = requireAccount(c);
  if (!account.ok) return c.json({ error: account.error }, account.status);
  const body = await c.req.json().catch(() => ({}));
  const currentPassword = String(body.currentPassword ?? "");
  const newPassword = String(body.newPassword ?? "");
  const validationError = validateAccountInput(account.user.email, newPassword);
  if (validationError) return c.json({ error: validationError }, 400);
  if (!(await verifyPassword(currentPassword, account.user.password_hash, account.user.password_salt))) {
    return c.json({ error: "当前密码不正确" }, 401);
  }
  const password = await hashPassword(newPassword);
  db.updateUserPassword(account.user.id, password.passwordHash, password.passwordSalt);
  startAccountSession(c, account.user.id);
  return c.json({ ok: true });
});

api.post("/auth/logout-all", (c) => {
  const account = requireAccount(c);
  if (!account.ok) return c.json({ error: account.error }, account.status);
  db.deleteAllAccountSessions(account.user.id);
  endAccountSession(c);
  return c.json({ ok: true });
});

api.post("/auth/reset-password", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const email = normalizeEmail(body.email);
  const code = String(body.code ?? "");
  const newPassword = String(body.newPassword ?? "");
  const validationError = validateAccountInput(email, newPassword);
  if (validationError) return c.json({ error: validationError }, 400);
  const password = await hashPassword(newPassword);
  if (!db.resetPasswordWithCode(email, code, password.passwordHash, password.passwordSalt)) {
    return c.json({ error: "重置码无效或已经过期" }, 403);
  }
  return c.json({ ok: true });
});

api.get("/account/export", (c) => {
  const account = requireAccount(c);
  if (!account.ok) return c.json({ error: account.error }, account.status);
  return c.json({ data: db.exportUserData(account.user.id) });
});

api.delete("/account", async (c) => {
  const account = requireAccount(c);
  if (!account.ok) return c.json({ error: account.error }, account.status);
  const body = await c.req.json().catch(() => ({}));
  const password = String(body.password ?? "");
  if (!(await verifyPassword(password, account.user.password_hash, account.user.password_salt))) {
    return c.json({ error: "密码不正确，账号没有被注销" }, 401);
  }
  if (!db.deleteUserPrivateData(account.user.id)) {
    return c.json({ error: "唯一所有者账号不能注销" }, 409);
  }
  endAccountSession(c);
  return c.json({ ok: true });
});

const privateNoStore = async (c: Context, next: () => Promise<void>) => {
  c.header("Cache-Control", "private, no-store, max-age=0");
  await next();
};
api.use("/private-memory", privateNoStore);
api.use("/private-memory/*", privateNoStore);

api.get("/private-memory", (c) => {
  const account = requireAccount(c);
  if (!account.ok) return c.json({ error: account.error }, account.status);
  return c.json(privateMemory.getPrivateMemory(account.user.id));
});

api.post("/private-memory/settings", async (c) => {
  const account = requireAccount(c);
  if (!account.ok) return c.json({ error: account.error }, account.status);
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  if (Object.keys(body).some(key => !(key === "enabled" || key === "expectedRevision")) || typeof body.enabled !== "boolean" || !Number.isInteger(body.expectedRevision))
    return c.json({ error: "INVALID_INPUT" }, 400);
  const result = privateMemory.updatePrivateMemorySettings(account.user.id, body.enabled, Number(body.expectedRevision));
  return "error" in result ? c.json({ error: result.error }, 409) : c.json(result.view);
});

api.patch("/private-memory/:id", async (c) => {
  const account = requireAccount(c);
  if (!account.ok) return c.json({ error: account.error }, account.status);
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  if (Object.keys(body).some(key => !(key === "content" || key === "expectedVersion" || key === "expectedRevision")) ||
      typeof body.content !== "string" || !body.content.trim() || body.content.length > 2000 ||
      !Number.isInteger(body.expectedVersion) || !Number.isInteger(body.expectedRevision)) return c.json({ error: "INVALID_INPUT" }, 400);
  const result = privateMemory.correctPrivateMemoryItem(account.user.id, c.req.param("id"), body.content.trim(), Number(body.expectedVersion), Number(body.expectedRevision));
  if ("error" in result) return c.json({ error: result.error }, result.error === "NOT_FOUND" ? 404 : result.error === "INVALID_CONTENT" ? 400 : 409);
  return c.json(result.view);
});

api.delete("/private-memory/:id", async (c) => {
  const account = requireAccount(c);
  if (!account.ok) return c.json({ error: account.error }, account.status);
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  if (Object.keys(body).some(key => !(key === "expectedVersion" || key === "expectedRevision")) || !Number.isInteger(body.expectedVersion) || !Number.isInteger(body.expectedRevision))
    return c.json({ error: "INVALID_INPUT" }, 400);
  const result = privateMemory.forgetPrivateMemoryItem(account.user.id, c.req.param("id"), Number(body.expectedVersion), Number(body.expectedRevision));
  if ("error" in result) return c.json({ error: result.error }, result.error === "NOT_FOUND" ? 404 : 409);
  return c.json(result.view);
});

api.delete("/private-memory", async (c) => {
  const account = requireAccount(c);
  if (!account.ok) return c.json({ error: account.error }, account.status);
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  if (Object.keys(body).some(key => key !== "expectedRevision") || !Number.isInteger(body.expectedRevision)) return c.json({ error: "INVALID_INPUT" }, 400);
  const result = privateMemory.clearPrivateMemory(account.user.id, Number(body.expectedRevision));
  return "error" in result ? c.json({ error: result.error }, 409) : c.json(result.view);
});

api.use("/conversations", privateNoStore);
api.use("/conversations/*", privateNoStore);

api.post("/conversations", async (c) => {
  const account=requireAccount(c); if(!account.ok)return c.json({error:account.error},account.status);
  const body=await c.req.json().catch(()=>({})) as Record<string,unknown>;
  if(Object.keys(body).some(key=>!(key==="title"||key==="clientRequestId"))||(body.title!==undefined&&typeof body.title!=="string")||(body.clientRequestId!==undefined&&(typeof body.clientRequestId!=="string"||!body.clientRequestId.trim()||body.clientRequestId.length>100)))return c.json({error:"会话标题或创建请求编号无效"},400);
  if(typeof body.clientRequestId==="string") {
    const result=privateCore.createConversationWithRequestId(account.user.id,String(body.title??""),body.clientRequestId.trim());
    if(result.retired)return c.json({error:"该创建请求编号对应的会话已删除，不能恢复",code:"IDEMPOTENCY_KEY_RETIRED"},409);
    return c.json({conversation:result.conversation},result.created?201:200);
  }
  return c.json({conversation:privateCore.createConversation(account.user.id,String(body.title??""))},201);
});

api.get("/conversations", (c) => {
  const account=requireAccount(c); if(!account.ok)return c.json({error:account.error},account.status);
  return c.json({conversations:privateCore.listConversations(account.user.id)});
});

api.get("/conversations/:id", (c) => {
  const account=requireAccount(c); if(!account.ok)return c.json({error:account.error},account.status);
  const detail=privateCore.getConversationDetail(account.user.id,c.req.param("id"));
  return detail?c.json(detail):c.json({error:"会话不存在或无权访问"},404);
});

api.delete("/conversations/:id", (c) => {
  const account=requireAccount(c); if(!account.ok)return c.json({error:account.error},account.status);
  return privateCore.deleteConversation(account.user.id,c.req.param("id"))?c.body(null,204):c.json({error:"会话不存在或无权访问"},404);
});

api.post("/conversations/:id/messages", async (c) => {
  const account=requireAccount(c); if(!account.ok)return c.json({error:account.error},account.status);
  const body=await c.req.json().catch(()=>({})) as Record<string,unknown>;
  if(Object.keys(body).some(key=>!(["content","clientRequestId"] as string[]).includes(key))||typeof body.content!=="string"||!body.content.trim()||body.content.length>16000||(body.clientRequestId!==undefined&&(typeof body.clientRequestId!=="string"||body.clientRequestId.length>100)))return c.json({error:"消息内容无效"},400);
  const result=privateCore.addUserMessage(account.user.id,c.req.param("id"),body.content.trim(),body.clientRequestId as string|undefined);
  if(!result)return c.json({error:"会话不存在或无权访问"},404);
  const jobId=result.jobId??privateCore.getJobForSource(account.user.id,c.req.param("id"),result.message.id)?.id??null;
  if(jobId)wakePrivateWorker();
  return c.json({...result,jobId},202);
});

api.patch("/conversations/:id/messages/:messageId", async (c) => {
  const account=requireAccount(c); if(!account.ok)return c.json({error:account.error},account.status);
  const body=await c.req.json().catch(()=>({})) as Record<string,unknown>;
  if(Object.keys(body).some(key=>!(["content","expectedVersion"] as string[]).includes(key))||typeof body.content!=="string"||!body.content.trim()||body.content.length>16000||!Number.isInteger(body.expectedVersion))return c.json({error:"修改内容或版本无效"},400);
  const result=privateCore.editUserMessage(account.user.id,c.req.param("id"),c.req.param("messageId"),body.content.trim(),Number(body.expectedVersion));
  if("error" in result)return c.json({error:result.error==="stale"?"会话内容已变化，请刷新后再编辑":result.error==="not_latest"?"只能修改最新一轮表达":"消息不存在或无权访问",code:result.error==="stale"?"VERSION_CONFLICT":result.error==="not_latest"?"MESSAGE_NOT_LATEST":"NOT_FOUND"},result.error==="not_found"?404:409);
  wakePrivateWorker(); return c.json(result,202);
});

api.delete("/conversations/:id/messages/:messageId", async (c) => {
  const account=requireAccount(c); if(!account.ok)return c.json({error:account.error},account.status);
  const body=await c.req.json().catch(()=>({})) as Record<string,unknown>;
  if(Object.keys(body).some(key=>key!=="expectedVersion")||!Number.isInteger(body.expectedVersion))return c.json({error:"会话版本无效"},400);
  const result=privateCore.deleteUserMessage(account.user.id,c.req.param("id"),c.req.param("messageId"),Number(body.expectedVersion));
  return result==="ok"?c.body(null,204):c.json({error:result==="stale"?"会话内容已变化，请刷新后再删除":result==="not_latest"?"只能删除最新一轮表达":"消息不存在或无权访问",code:result==="stale"?"VERSION_CONFLICT":result==="not_latest"?"MESSAGE_NOT_LATEST":"NOT_FOUND"},result==="not_found"?404:409);
});

api.post("/conversations/:id/messages/:messageId/feedback", async (c) => {
  const account=requireAccount(c); if(!account.ok)return c.json({error:account.error},account.status);
  const body=await c.req.json().catch(()=>({})) as Record<string,unknown>;
  if(!body||typeof body!=="object"||Array.isArray(body))return c.json({error:"反馈内容无效",code:"INVALID_FEEDBACK"},400);
  if(Object.keys(body).some(key=>!(key==="rating"||key==="reason"||key==="expectedVersion"))||!("rating" in body)||!Number.isInteger(body.expectedVersion)||!privateCore.isValidReplyFeedback(body.rating,body.reason)||("reason" in body&&body.reason!==null&&!privateCore.isReplyFeedbackReason(body.reason)))return c.json({error:"反馈内容无效",code:"INVALID_FEEDBACK"},400);
  const result=privateCore.setLatestReplyFeedback(account.user.id,c.req.param("id"),c.req.param("messageId"),body.rating as privateCore.ReplyFeedbackRating|null,(body.reason??null) as privateCore.ReplyFeedbackReason|null,Number(body.expectedVersion));
  if("error" in result)return c.json({error:result.error==="stale"?"会话内容已变化，请刷新后再反馈":result.error==="not_latest"?"只能反馈最新一轮回复":result.error==="invalid_feedback"?"反馈内容无效":"会话不存在或无权访问",code:result.error==="stale"?"VERSION_CONFLICT":result.error==="not_latest"?"MESSAGE_NOT_LATEST":result.error==="invalid_feedback"?"INVALID_FEEDBACK":"NOT_FOUND"},result.error==="not_found"?404:result.error==="invalid_feedback"?400:409);
  return c.json(result);
});

api.delete("/conversations/:id/response-preferences", async (c) => {
  const account=requireAccount(c); if(!account.ok)return c.json({error:account.error},account.status);
  const body=await c.req.json().catch(()=>({})) as Record<string,unknown>;
  if(!body||typeof body!=="object"||Array.isArray(body))return c.json({error:"会话版本无效",code:"INVALID_VERSION"},400);
  if(Object.keys(body).some(key=>key!=="expectedVersion")||!Number.isInteger(body.expectedVersion))return c.json({error:"会话版本无效",code:"INVALID_VERSION"},400);
  const result=privateCore.clearConversationResponsePreferences(account.user.id,c.req.param("id"),Number(body.expectedVersion));
  if("error" in result)return c.json({error:result.error==="stale"?"会话内容已变化，请刷新后再清除":"会话不存在或无权访问",code:result.error==="stale"?"VERSION_CONFLICT":"NOT_FOUND"},result.error==="stale"?409:404);
  return c.json(result);
});

api.get("/conversations/:id/jobs/:jobId", (c) => {
  const account=requireAccount(c); if(!account.ok)return c.json({error:account.error},account.status);
  const job=privateCore.getPrivateJob(account.user.id,c.req.param("id"),c.req.param("jobId"));
  if(!job)return c.json({error:"任务不存在或无权访问"},404);
  const assistantMessage=privateCore.getJobMessage(account.user.id,c.req.param("id"),job.id);
  return c.json({job,...(assistantMessage?{assistantMessage}:{})});
});

api.post("/conversations/:id/jobs/:jobId/cancel", (c) => {
  const account=requireAccount(c); if(!account.ok)return c.json({error:account.error},account.status);
  const job=privateCore.cancelJob(account.user.id,c.req.param("id"),c.req.param("jobId"));
  return job?c.json({job}):c.json({error:"任务不存在或无权访问"},404);
});

api.post("/conversations/:id/jobs/:jobId/retry", (c) => {
  const account=requireAccount(c); if(!account.ok)return c.json({error:account.error},account.status);
  const job=privateCore.retryJob(account.user.id,c.req.param("id"),c.req.param("jobId"));
  if(!job)return c.json({error:"任务已过期、输入版本已变化，或当前任务不可重试",code:"JOB_NOT_RETRYABLE"},409);
  wakePrivateWorker(); return c.json({jobId:job.id},202);
});

api.post("/conversations/:id/notes/refresh", (c) => {
  const account=requireAccount(c); if(!account.ok)return c.json({error:account.error},account.status);
  const job=privateCore.createNotesJob(account.user.id,c.req.param("id"));
  if(!job)return c.json({error:"会话不存在或无权访问"},404);
  wakePrivateWorker(); return c.json({jobId:job.id,notesVersion:job.inputVersion},202);
});

api.patch("/conversations/:id/notes/:noteId", async (c) => {
  const account=requireAccount(c); if(!account.ok)return c.json({error:account.error},account.status);
  const body=await c.req.json().catch(()=>({})) as Record<string,unknown>;
  if(Object.keys(body).some(key=>!(["correction","expectedVersion"] as string[]).includes(key))||typeof body.correction!=="string"||!body.correction.trim()||body.correction.length>2000||!Number.isInteger(body.expectedVersion))return c.json({error:"笔记纠正内容或版本无效"},400);
  const result=privateCore.correctNote(account.user.id,c.req.param("id"),c.req.param("noteId"),body.correction.trim(),Number(body.expectedVersion));
  if("error" in result)return c.json({error:result.error==="stale"?"笔记已变化，请刷新后再纠正":"笔记不存在或无权访问",code:result.error==="stale"?"STALE_VERSION":"NOT_FOUND"},result.error==="stale"?409:404);
  return c.json(result);
});

api.post("/conversations/:id/event-summary/confirm", async (c) => {
  const account=requireAccount(c); if(!account.ok)return c.json({error:account.error},account.status);
  const body=await c.req.json().catch(()=>({})) as Record<string,unknown>;
  if(Object.keys(body).some(key=>!(["content","expectedVersion"] as string[]).includes(key))||typeof body.content!=="string"||!body.content.trim()||body.content.length>8000||!Number.isInteger(body.expectedVersion))return c.json({error:"请确认自己的摘要内容和会话版本"},400);
  const result=privateCore.confirmEventSummary(account.user.id,c.req.param("id"),body.content.trim(),Number(body.expectedVersion));
  if(result!=="ok")return c.json({error:result==="active_risk"?"当前会话含有尚未解除的安全风险，暂不能分享":result==="stale"?"会话内容已变化，请刷新后再确认":result==="wrong_state"?"当前复盘状态不允许确认摘要":"会话不存在或无权访问",code:result==="active_risk"?"ACTIVE_SAFETY_RISK":result==="stale"?"STALE_VERSION":"INVALID_STATE"},result==="not_found"?404:409);
  wakeAiWorker(); return c.json({confirmed:true},200);
});

api.post("/conversations/:id/share-drafts", async (c) => {
  const account=requireAccount(c); if(!account.ok)return c.json({error:account.error},account.status);
  const body=await c.req.json().catch(()=>({})) as Record<string,unknown>;
  if(Object.keys(body).some(key=>key!=="sourceMessageIds")||!Array.isArray(body.sourceMessageIds)||body.sourceMessageIds.some(id=>typeof id!=="string")||body.sourceMessageIds.length<1||body.sourceMessageIds.length>100)return c.json({error:"请选择本人在本对话中发送的消息"},400);
  if(privateCore.conversationHasActiveRisk(account.user.id,c.req.param("id")))return c.json({error:"当前会话含有尚未解除的安全风险，暂不能创建分享草稿",code:"ACTIVE_SAFETY_RISK"},409);
  const result=privateCore.createShareDraftJob(account.user.id,c.req.param("id"),body.sourceMessageIds as string[]);
  if(result===null)return c.json({error:"会话不存在或无权访问"},404);
  if(result===false)return c.json({error:"所选消息不存在、已修改或不属于本人"},409);
  wakePrivateWorker(); return c.json(result,202);
});

api.get("/conversations/:id/share-drafts/:draftId", (c) => {
  const account=requireAccount(c); if(!account.ok)return c.json({error:account.error},account.status);
  const draft=privateCore.getShareDraft(account.user.id,c.req.param("id"),c.req.param("draftId"));
  return draft?c.json({draft}):c.json({error:"分享草稿不存在或无权访问"},404);
});

api.patch("/conversations/:id/share-drafts/:draftId", async (c) => {
  const account=requireAccount(c); if(!account.ok)return c.json({error:account.error},account.status);
  const body=await c.req.json().catch(()=>({})) as Record<string,unknown>;
  if(Object.keys(body).some(key=>!(["content","expectedVersion"] as string[]).includes(key))||typeof body.content!=="string"||!body.content.trim()||body.content.length>10000||!Number.isInteger(body.expectedVersion))return c.json({error:"草稿内容或版本无效"},400);
  const result=privateCore.patchShareDraft(account.user.id,c.req.param("id"),c.req.param("draftId"),body.content.trim(),Number(body.expectedVersion));
  if("error" in result)return c.json({error:result.error==="stale"?"草稿已变化，请刷新后再编辑":"草稿不存在或无权访问",code:result.error==="stale"?"STALE_VERSION":"NOT_FOUND"},result.error==="stale"?409:404);
  return c.json(result);
});

api.post("/conversations/:id/share-drafts/:draftId/confirm", async (c) => {
  const account=requireAccount(c); if(!account.ok)return c.json({error:account.error},account.status);
  const body=await c.req.json().catch(()=>({})) as Record<string,unknown>;
  if(Object.keys(body).some(key=>!(["version","invitePartner"] as string[]).includes(key))||!Number.isInteger(body.version)||body.invitePartner!==true)return c.json({error:"请确认当前草稿版本并选择邀请伴侣"},400);
  try {
    const result=privateCore.confirmShareDraft(account.user.id,c.req.param("id"),c.req.param("draftId"),Number(body.version));
    if("error" in result) {
      if(result.error==="partner_binding_required")return c.json({error:"PARTNER_BINDING_REQUIRED",code:"PARTNER_BINDING_REQUIRED",message:"请先在伴侣设置中建立双方确认的绑定，再分享这份草稿。草稿仍为私密状态，可以继续编辑。"},409);
      if(result.error==="active_risk")return c.json({error:"当前会话含有尚未解除的安全风险，暂不能分享",code:"ACTIVE_SAFETY_RISK"},409);
      const stale=result.error==="stale";
      const conflict=result.error==="empty_draft"||result.error==="wrong_state";
      return c.json({error:stale?"草稿已变化，请重新查看当前版本":result.error==="empty_draft"?"分享草稿尚无可确认的正文":result.error==="wrong_state"?"当前复盘状态不允许确认摘要":"草稿不存在或无权访问",code:stale?"STALE_VERSION":conflict?"INVALID_STATE":"NOT_FOUND"},stale||conflict?409:404);
    }
    wakeAiWorker();
    return c.json(result,201);
  } catch(error) {
    if(error instanceof Error&&error.message==="partner binding changed")return c.json({error:"PARTNER_BINDING_REQUIRED",code:"PARTNER_BINDING_REQUIRED",message:"伴侣绑定已变化。草稿仍为私密状态，请确认绑定后重试。"},409);
    throw error;
  }
});

// ---------- 伴侣连接与双人空间 ----------

api.get("/partner", (c) => {
  const account = requireAccount(c);
  if (!account.ok) return c.json({ error: account.error }, account.status);
  return c.json({
    ...db.getPartnerOverview(account.user.id),
    eventInvites: db.listPartnerEventInvites(account.user.id, Date.now() - INVITE_TTL_MS),
  });
});

api.post("/partner/invites", (c) => {
  const account = requireAccount(c);
  if (!account.ok) return c.json({ error: account.error }, account.status);
  const invite = db.createPartnerInvite(account.user.id);
  if (!invite) return c.json({ error: "你已经连接了伴侣" }, 409);
  return c.json({ invite }, 201);
});

api.delete("/partner/invites/:id", (c) => {
  const account = requireAccount(c);
  if (!account.ok) return c.json({ error: account.error }, account.status);
  if (!db.revokePartnerInvite(account.user.id, c.req.param("id"))) {
    return c.json({ error: "邀请已经使用、撤回或过期" }, 409);
  }
  return c.json({ ok: true });
});

api.post("/partner/invites/accept", async (c) => {
  const account = requireAccount(c);
  if (!account.ok) return c.json({ error: account.error }, account.status);
  const code = String((await c.req.json().catch(() => ({}))).code ?? "");
  if (!db.acceptPartnerInvite(code, account.user.id)) {
    return c.json({ error: "伴侣连接码无效、已过期，或其中一方已经连接伴侣" }, 409);
  }
  return c.json({ ok: true, approvalPending: true });
});

api.post("/partner/invites/:id/approve", (c) => {
  const account = requireAccount(c);
  if (!account.ok) return c.json({ error: account.error }, account.status);
  if (!db.approvePartnerBindingRequest(account.user.id, c.req.param("id"))) {
    return c.json({ error: "这次绑定申请已经失效，或其中一方已有伴侣" }, 409);
  }
  return c.json({ ok: true });
});

api.delete("/partner/requests/:id", (c) => {
  const account = requireAccount(c);
  if (!account.ok) return c.json({ error: account.error }, account.status);
  if (!db.cancelPartnerBindingRequest(account.user.id, c.req.param("id"))) {
    return c.json({ error: "这次绑定申请已经处理或失效" }, 409);
  }
  return c.json({ ok: true });
});

api.post("/partner/connection/pause", async (c) => {
  const account = requireAccount(c);
  if (!account.ok) return c.json({ error: account.error }, account.status);
  const days = Number((await c.req.json().catch(() => ({}))).days);
  if (days !== 1 && days !== 3 && days !== 7) {
    return c.json({ error: "暂停时间只能选择 1、3 或 7 天" }, 400);
  }
  if (!db.pausePartnerConnection(account.user.id, days)) {
    return c.json({ error: "当前关系不能暂停" }, 409);
  }
  return c.json({ ok: true });
});

api.post("/partner/connection/resume", (c) => {
  const account = requireAccount(c);
  if (!account.ok) return c.json({ error: account.error }, account.status);
  if (!db.resumePartnerConnection(account.user.id)) {
    return c.json({ error: "当前没有由你发起的暂停" }, 409);
  }
  return c.json({ ok: true });
});

api.delete("/partner/connection", (c) => {
  const account = requireAccount(c);
  if (!account.ok) return c.json({ error: account.error }, account.status);
  if (!db.requestPartnerDisconnect(account.user.id)) {
    return c.json({ error: "当前没有可解绑的伴侣连接" }, 409);
  }
  return c.json({ ok: true, undoHours: 24 });
});

api.post("/partner/connection/cancel-disconnect", (c) => {
  const account = requireAccount(c);
  if (!account.ok) return c.json({ error: account.error }, account.status);
  if (!db.cancelPartnerDisconnect(account.user.id)) {
    return c.json({ error: "这次解绑不能撤销，或不是由你发起" }, 409);
  }
  return c.json({ ok: true });
});

api.post("/partner/connections/:id/recovery-request", async (c) => {
  const account = requireAccount(c);
  if (!account.ok) return c.json({ error: account.error }, account.status);
  const restoreMemories = Boolean((await c.req.json().catch(() => ({}))).restoreMemories);
  if (!db.requestPartnerRecovery(account.user.id, c.req.param("id"), restoreMemories)) {
    return c.json({ error: "这段关系已超过恢复期，或其中一方已有新伴侣" }, 409);
  }
  return c.json({ ok: true });
});

api.post("/partner/connections/:id/recovery-approve", (c) => {
  const account = requireAccount(c);
  if (!account.ok) return c.json({ error: account.error }, account.status);
  if (!db.approvePartnerRecovery(account.user.id, c.req.param("id"))) {
    return c.json({ error: "这次恢复申请已经失效" }, 409);
  }
  return c.json({ ok: true });
});

api.get("/partner/space", (c) => {
  const account = requireAccount(c);
  if (!account.ok) return c.json({ error: account.error }, account.status);
  const space = db.getSharedSpaceForUser(account.user.id);
  if (!space) return c.json({ error: "连接伴侣后才能进入共同空间" }, 409);
  return c.json({ space });
});

api.post("/partner/space/proposals", async (c) => {
  const account = requireAccount(c);
  if (!account.ok) return c.json({ error: account.error }, account.status);
  const body = await c.req.json().catch(() => ({}));
  const proposal = db.createSharedMemoryProposal(
    account.user.id,
    String(body.category ?? ""),
    String(body.content ?? "")
  );
  if (!proposal) {
    return c.json({ error: "内容不能为空；同一主题如有待确认内容，请先处理或直接修改" }, 409);
  }
  return c.json({ proposal, space: db.getSharedSpaceForUser(account.user.id) }, 201);
});

api.patch("/partner/space/proposals/:id", async (c) => {
  const account = requireAccount(c);
  if (!account.ok) return c.json({ error: account.error }, account.status);
  const body = await c.req.json().catch(() => ({}));
  if (!db.reviseSharedMemoryProposal(account.user.id, c.req.param("id"), String(body.content ?? ""))) {
    return c.json({ error: "这条内容已经失效，或当前伴侣连接已结束" }, 409);
  }
  return c.json({ space: db.getSharedSpaceForUser(account.user.id) });
});

api.post("/partner/space/proposals/:id/confirm", async (c) => {
  const account = requireAccount(c);
  if (!account.ok) return c.json({ error: account.error }, account.status);
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  if (Object.keys(body).some(key => key !== "expectedVersion") || !Number.isSafeInteger(body.expectedVersion) || Number(body.expectedVersion) < 1) {
    return c.json({ error: "请确认当前看到的提案版本", code: "INVALID_VERSION" }, 400);
  }
  if (!db.confirmSharedMemoryProposal(account.user.id, c.req.param("id"), Number(body.expectedVersion))) {
    return c.json({ error: "这条内容已变化、已经处理或失效，请刷新后查看并重新确认", code: "VERSION_CONFLICT" }, 409);
  }
  return c.json({ space: db.getSharedSpaceForUser(account.user.id) });
});

api.post("/partner/space/proposals/:id/reject", async (c) => {
  const account = requireAccount(c);
  if (!account.ok) return c.json({ error: account.error }, account.status);
  const body = await c.req.json().catch(() => ({}));
  if (
    !db.rejectSharedMemoryProposal(
      account.user.id,
      c.req.param("id"),
      String(body.reason ?? "")
    )
  ) {
    return c.json({ error: "这条内容已经处理或失效" }, 409);
  }
  return c.json({ space: db.getSharedSpaceForUser(account.user.id) });
});

api.post("/partner/event-invites/:id/accept", (c) => {
  const account = requireAccount(c);
  if (!account.ok) return c.json({ error: account.error }, account.status);
  const id = c.req.param("id");
  const event = db.getEvent(id);
  if (!event || Date.now() - (event.invite_created_at ?? event.created_at) > INVITE_TTL_MS) {
    return c.json({ error: "这次复盘邀请已经过期" }, 410);
  }
  const token = db.acceptPartnerEventInvite(id, account.user.id);
  if (!token) return c.json({ error: "这次复盘邀请已经失效" }, 409);
  setRoleCookie(c, id, token);
  db.saveGuideSession(id, "b", "story", JSON.stringify(emptyStoryMap()));
  db.addGuideMessage(
    id,
    "b",
    "ai",
    "欢迎。这里先不分析对错，也不会让你替对方解释。你愿意从事情发生前的背景说起吗？"
  );
  const conversation=privateCore.getOrCreateEventConversation(account.user.id,id,"b");
  return c.json({ id, conversationId:conversation?.id ?? null });
});

api.post("/partner/event-invites/:id/later", (c) => {
  const account = requireAccount(c);
  if (!account.ok) return c.json({ error: account.error }, account.status);
  if (!db.snoozePartnerEventInvite(c.req.param("id"), account.user.id)) {
    return c.json({ error: "这次复盘邀请已经失效" }, 409);
  }
  return c.json({ ok: true });
});

// ---------- 管理员内测邀请 ----------

api.post("/analytics/events", async (c) => {
  const account=requireAccount(c); if(!account.ok)return c.json({error:account.error},account.status);
  const sessionId=c.req.header("x-deepwe-session")?.trim()??"";
  if(!ANALYTICS_SESSION_RE.test(sessionId))return c.json({error:"体验会话编号无效"},400);
  const body=await c.req.json().catch(()=>({})) as Record<string,unknown>;
  const allowed=new Set(["name","eventId","screen","step","result","reason","durationMs"]);
  if(Object.keys(body).some(key=>!allowed.has(key)))return c.json({error:"体验数据包含不允许的字段"},400);
  const name=String(body.name??"");
  if(!ANALYTICS_EVENTS.has(name))return c.json({error:"体验事件不在允许范围内"},400);
  const pick=(key:string,set:Set<string>)=>body[key]===undefined||body[key]===null?undefined:(typeof body[key]==="string"&&set.has(body[key] as string)?body[key] as string:null);
  const screen=pick("screen",ANALYTICS_SCREENS),step=pick("step",ANALYTICS_STEPS),result=pick("result",ANALYTICS_VALUES),reason=pick("reason",ANALYTICS_VALUES);
  if(screen===null||step===null||result===null||reason===null)return c.json({error:"体验数据标记无效"},400);
  const duration=body.durationMs===undefined||body.durationMs===null?undefined:Number(body.durationMs);
  if(duration!==undefined&&(!Number.isFinite(duration)||duration<0||duration>86400000))return c.json({error:"停留时间无效"},400);
  if(name==="core_outcome_submitted"&&(!result||!(["lighter","same","worse","unclear","skipped"] as string[]).includes(result)))return c.json({error:"结束感受反馈不完整"},400);
  const eventId=body.eventId===undefined||body.eventId===null?undefined:String(body.eventId);
  if(eventId) {
    const event=db.getEvent(eventId);
    const privateConversation=privateCore.getOwnedConversation(account.user.id,eventId);
    if((!event||![event.a_user_id,event.b_user_id,event.partner_target_user_id].includes(account.user.id))&&!privateConversation)return c.json({error:"关联的潜谈不存在或无权访问"},403);
  }
  const recorded=privateCore.recordAnalytics(account.user.id,sessionId,{name,eventId,screen:screen??undefined,step:step??undefined,result:result??undefined,reason:reason??undefined,durationMs:duration});
  return c.json({recorded});
});

api.patch("/account/analytics-preference", async (c) => {
  const account=requireAccount(c); if(!account.ok)return c.json({error:account.error},account.status);
  const body=await c.req.json().catch(()=>({})) as Record<string,unknown>;
  if(Object.keys(body).length!==1||typeof body.enabled!=="boolean")return c.json({error:"请选择是否允许体验数据"},400);
  privateCore.setAnalyticsPreference(account.user.id,body.enabled);
  return c.json({analyticsEnabled:body.enabled,analyticsNoticeSeen:true});
});

api.post("/account/analytics-notice", (c) => {
  const account=requireAccount(c); if(!account.ok)return c.json({error:account.error},account.status);
  privateCore.markAnalyticsNoticeSeen(account.user.id);
  return c.json({analyticsNoticeSeen:true});
});

api.get("/admin/analytics", (c) => {
  const owner=requireAdmin(c); if(!owner.ok)return c.json({error:owner.error},owner.status);
  const days=Number(c.req.query("days")??7);
  if(days!==7&&days!==30&&days!==90)return c.json({error:"时间范围只能选择最近 7、30 或 90 天"},400);
  return c.json({analytics:privateCore.getAnalyticsDashboard(days)});
});

api.get("/admin/registration-invites", (c) => {
  const admin = requireAdmin(c);
  if (!admin.ok) return c.json({ error: admin.error }, admin.status);
  return c.json({ invites: db.listRegistrationInvites(admin.user.id) });
});

api.post("/admin/registration-invites", async (c) => {
  const admin = requireAdmin(c);
  if (!admin.ok) return c.json({ error: admin.error }, admin.status);
  const body = await c.req.json().catch(() => ({}));
  const note = String(body.note ?? "").trim();
  if (note.length > 60) return c.json({ error: "备注不能超过 60 个字" }, 400);
  const invite = db.createRegistrationInvite(admin.user.id, note);
  return c.json({ invite }, 201);
});

api.delete("/admin/registration-invites/:id", (c) => {
  const admin = requireAdmin(c);
  if (!admin.ok) return c.json({ error: admin.error }, admin.status);
  const revoked = db.revokeRegistrationInvite(c.req.param("id"), admin.user.id);
  if (!revoked) return c.json({ error: "邀请码不存在、已使用或已经撤回" }, 409);
  return c.json({ ok: true });
});

api.get("/admin/users", (c) => {
  const admin = requireAdmin(c);
  if (!admin.ok) return c.json({ error: admin.error }, admin.status);
  return c.json({ users: db.listUsersForAdmin() });
});

api.post("/admin/password-resets", async (c) => {
  const admin = requireAdmin(c);
  if (!admin.ok) return c.json({ error: admin.error }, admin.status);
  const body = await c.req.json().catch(() => ({}));
  const reset = db.createPasswordResetCode(String(body.userId ?? ""), admin.user.id);
  if (!reset) return c.json({ error: "账号不存在" }, 404);
  return c.json({ reset }, 201);
});

// ---------- 写操作 ----------

// 1) A 创建事件 + 一句话起头 → AI 立即接话
api.post("/events", async (c) => {
  const account = requireAccount(c);
  if (!account.ok) return c.json({ error: account.error }, account.status);
  const body = await c.req.json().catch(() => ({}));
  const title = String(body.title ?? "").trim();
  const rawText = String(body.rawText ?? "").trim();
  if (!title || !rawText) return c.json({ error: "请填写标题和你的表达" }, 400);

  const initialRisk = riskLevel(`${title} ${rawText}`);
  if (initialRisk !== "none") {
    const { id, aToken } = db.createEvent(title, account.user.id);
    db.upsertPerspective(id, "a", rawText);
    db.addGuideMessage(id, "a", "a", rawText);
    setRoleCookie(c, id, aToken);
    db.setRisk(id, initialRisk, "a");
    db.transition(id, "a_guiding", "safety_exit");
    return c.json({ id });
  }

  const { id, aToken } = db.createEvent(title, account.user.id);
  db.upsertPerspective(id, "a", rawText);
  const messageId = db.addGuideMessage(id, "a", "a", rawText);
  db.enqueueAiJob(id, "guide", "a", messageId);
  setRoleCookie(c, id, aToken);
  wakeAiWorker();
  return c.json({ id, queued: true }, 202);
});

// 3) B 用邀请码加入
api.post("/events/join", async (c) => {
  const account = requireAccount(c);
  if (!account.ok) return c.json({ error: account.error }, account.status);
  const body = await c.req.json().catch(() => ({}));
  const code = String(body.code ?? "").trim().toUpperCase();
  if (!code) return c.json({ error: "请填写邀请码" }, 400);
  const ev = db.getEventByCode(code);
  if (!ev) return c.json({ error: "邀请码无效" }, 404);
  if (ev.invite_mode !== "legacy_code") {
    return c.json({ error: "情侣复盘不使用邀请码，请从伴侣邀请中进入" }, 409);
  }
  if (Date.now() - (ev.invite_created_at ?? ev.created_at) > INVITE_TTL_MS) {
    return c.json({ error: "邀请已过期" }, 410);
  }
  if (ev.a_user_id === account.user.id) {
    return c.json({ error: "不能加入自己发起的潜谈" }, 409);
  }
  if (ev.b_user_id === account.user.id) return c.json({ id: ev.id });
  if (ev.state !== "waiting_b") return c.json({ error: "当前状态无法加入" }, 409);
  if (ev.partner_target_user_id && ev.partner_target_user_id !== account.user.id) {
    return c.json({ error: "这次复盘已经定向邀请给伴侣，其他账号不能加入" }, 403);
  }

  if (ev.b_user_id || ev.b_token) return c.json({ error: "该邀请码已被使用" }, 409);

  const bToken = db.randomToken();
  if (!db.setBParticipant(ev.id, bToken, account.user.id)) {
    return c.json({ error: "该邀请码已被使用" }, 409);
  }
  setRoleCookie(c, ev.id, bToken);
  db.transition(ev.id, "waiting_b", "b_guiding");
  db.saveGuideSession(ev.id, "b", "story", JSON.stringify(emptyStoryMap()));
  db.addGuideMessage(
    ev.id,
    "b",
    "ai",
    "欢迎。这里先不分析对错，也不会让你替对方解释。你愿意从事情发生前的背景说起吗？"
  );
  return c.json({ id: ev.id });
});

api.get("/events", (c) => {
  const account = requireAccount(c);
  if (!account.ok) return c.json({ error: account.error }, account.status);
  return c.json({ events: db.listEventsForUser(account.user.id) });
});

api.delete("/events/:id", (c) => {
  const account = requireAccount(c);
  if (!account.ok) return c.json({ error: account.error }, account.status);
  const id = c.req.param("id");
  const event = db.getEvent(id);
  if (!event) return c.json({ error: "这次潜谈不存在或已经删除" }, 404);
  if (event.a_user_id !== account.user.id && event.b_user_id !== account.user.id) {
    return c.json({ error: "无权限删除这次潜谈" }, 403);
  }
  const hasOtherParticipant = Boolean(
    event.a_user_id && event.b_user_id && event.a_user_id !== event.b_user_id
  );
  if (hasOtherParticipant) {
    if (!db.hideEventForUser(id, account.user.id)) {
      return c.json({ error: "无法从你的记录中移除" }, 409);
    }
    return c.json({ ok: true, hiddenOnly: true });
  }
  if (!db.deleteEventCompletely(id)) {
    return c.json({ error: "这次潜谈已经删除" }, 404);
  }
  return c.json({ ok: true, hiddenOnly: false });
});

api.delete("/events/:id/private-data", (c) => {
  const account = requireAccount(c);
  if (!account.ok) return c.json({ error: account.error }, account.status);
  if (!db.clearOwnPrivateEventData(c.req.param("id"), account.user.id)) {
    return c.json({ error: "这次潜谈不存在或无权处理" }, 404);
  }
  return c.json({ ok: true });
});

api.post("/events/:id/deletion-request", (c) => {
  const account = requireAccount(c);
  if (!account.ok) return c.json({ error: account.error }, account.status);
  const status = db.requestEventDeletion(c.req.param("id"), account.user.id);
  if (!status) return c.json({ error: "这次潜谈不存在或无权处理" }, 404);
  return c.json({ ok: true, status });
});

api.delete("/events/:id/deletion-request", (c) => {
  const account = requireAccount(c);
  if (!account.ok) return c.json({ error: account.error }, account.status);
  if (!db.cancelEventDeletionRequest(c.req.param("id"), account.user.id)) {
    return c.json({ error: "当前没有可撤销的删除确认" }, 409);
  }
  return c.json({ ok: true });
});

api.patch("/events/:id/title", async (c) => {
  const account = requireAccount(c);
  if (!account.ok) return c.json({ error: account.error }, account.status);
  const title = String((await c.req.json().catch(() => ({}))).title ?? "").trim();
  if (!title || title.length > 80) return c.json({ error: "标题需要填写，并且不能超过 80 个字" }, 400);
  if (!db.renameEvent(c.req.param("id"), account.user.id, title)) {
    return c.json({ error: "这次潜谈不存在或无权修改" }, 404);
  }
  return c.json({ ok: true, title });
});

// 1.5) A/B 在潜谈中发消息，AI 回复
api.post("/events/:id/guide", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  const message = String(body.message ?? "").trim();
  if (!message) return c.json({ error: "请先输入你的想法" }, 400);

  const role = getSessionRole(c, id);
  if (role !== "a" && role !== "b") return c.json({ error: "无权限执行此操作" }, 403);
  const state = role === "a" ? "a_guiding" : "b_guiding";
  const auth = requireRole(c, id, role, [state]);
  if (!auth.ok) return c.json({ error: auth.error }, auth.status);

  const messageRisk = riskLevel(message);
  if (messageRisk !== "none") {
    db.addGuideMessage(id, role, role, message);
    db.setRisk(id, messageRisk, role);
    db.transition(id, state, "safety_exit");
    return c.json({});
  }

  if (db.getUnresolvedAiJob(id)) {
    return c.json({ error: "上一条内容还在处理中，请等待完成或先重试" }, 409);
  }

  const messageId = db.addGuideMessage(id, role, role, message);
  db.enqueueAiJob(id, "guide", role, messageId);
  wakeAiWorker();
  return c.json({ queued: true }, 202);
});

// 修改本人已经发送的内容后，从该处重新生成后续对话，避免 AI 继续沿用错误信息。
api.patch("/events/:id/guide/messages/:messageId", async (c) => {
  const id = c.req.param("id");
  const messageId = Number(c.req.param("messageId"));
  const body = await c.req.json().catch(() => ({}));
  const message = String(body.message ?? "").trim();
  if (!Number.isSafeInteger(messageId) || messageId <= 0) {
    return c.json({ error: "这条消息不存在" }, 404);
  }
  if (!message) return c.json({ error: "修改后的内容不能为空" }, 400);

  const role = getSessionRole(c, id);
  if (role !== "a" && role !== "b") return c.json({ error: "无权限执行此操作" }, 403);
  const state = role === "a" ? "a_guiding" : "b_guiding";
  const auth = requireRole(c, id, role, [state]);
  if (!auth.ok) return c.json({ error: auth.error }, auth.status);

  const edited = db.editGuideMessageAndRewind(
    id,
    role,
    messageId,
    message,
    JSON.stringify(emptyStoryMap())
  );
  if (!edited) return c.json({ error: "只能修改刚刚发出的最新一条消息" }, 409);

  const editedMessageRisk = riskLevel(message);
  if (editedMessageRisk !== "none") {
    db.setRisk(id, editedMessageRisk, role);
    db.transition(id, state, "safety_exit");
    return c.json({});
  }

  db.enqueueAiJob(id, "guide", role, messageId);
  wakeAiWorker();
  return c.json({ queued: true }, 202);
});

api.delete("/events/:id/guide/messages/:messageId", (c) => {
  const id = c.req.param("id");
  const messageId = Number(c.req.param("messageId"));
  if (!Number.isSafeInteger(messageId) || messageId <= 0) {
    return c.json({ error: "这条消息不存在" }, 404);
  }
  const role = getSessionRole(c, id);
  if (role !== "a" && role !== "b") return c.json({ error: "无权限执行此操作" }, 403);
  const state = role === "a" ? "a_guiding" : "b_guiding";
  const auth = requireRole(c, id, role, [state]);
  if (!auth.ok) return c.json({ error: auth.error }, auth.status);
  if (!db.deleteGuideMessageAndFollowing(id, role, messageId, JSON.stringify(emptyStoryMap()))) {
    return c.json({ error: "只能撤回刚刚发出的最新一条消息" }, 409);
  }
  return c.json({ ok: true });
});

api.post("/events/:id/guide/messages/:messageId/regenerate", async (c) => {
  const id = c.req.param("id");
  const messageId = Number(c.req.param("messageId"));
  const body = await c.req.json().catch(() => ({}));
  const reason = String(body.reason ?? "重新回答").trim().slice(0, 40);
  if (!Number.isSafeInteger(messageId) || messageId <= 0) {
    return c.json({ error: "这条消息不存在" }, 404);
  }
  const role = getSessionRole(c, id);
  if (role !== "a" && role !== "b") return c.json({ error: "无权限执行此操作" }, 403);
  const state = role === "a" ? "a_guiding" : "b_guiding";
  const auth = requireRole(c, id, role, [state]);
  if (!auth.ok) return c.json({ error: auth.error }, auth.status);
  if (!db.restartGuideFromMessage(id, role, messageId, reason, JSON.stringify(emptyStoryMap()))) {
    return c.json({ error: "只能重新生成刚刚收到的最新回复" }, 409);
  }
  db.enqueueAiJob(id, "guide", role, messageId);
  wakeAiWorker();
  return c.json({ queued: true }, 202);
});

api.post("/events/:id/ai/stop", (c) => {
  const id = c.req.param("id");
  const role = getSessionRole(c, id);
  if (role !== "a" && role !== "b") return c.json({ error: "无权限执行此操作" }, 403);
  const state = role === "a" ? "a_guiding" : "b_guiding";
  const auth = requireRole(c, id, role, [state]);
  if (!auth.ok) return c.json({ error: auth.error }, auth.status);
  if (!db.cancelVisibleAiJob(id, role)) return c.json({ error: "当前没有正在生成的回复" }, 409);
  return c.json({ ok: true });
});

// 用户主动结束潜谈后，可选择生成一份仍需本人修改确认的表达草稿。
api.post("/events/:id/guide/finish", async (c) => {
  const id = c.req.param("id");
  const role = getSessionRole(c, id);
  if (role !== "a" && role !== "b") return c.json({ error: "无权限执行此操作" }, 403);
  const state = role === "a" ? "a_guiding" : "b_guiding";
  const auth = requireRole(c, id, role, [state]);
  if (!auth.ok) return c.json({ error: auth.error }, auth.status);

  if (db.getUnresolvedAiJob(id)) {
    return c.json({ error: "当前回复还在生成；你可以直接结束，或等它完成后再整理表达" }, 409);
  }

  const msgs = db.getGuideMessages(id, role);
  const myText = msgs
    .filter((m) => m.role !== "ai")
    .map((m) => m.content)
    .join("\n");
  const p = db.getPerspective(id, role);
  const full = myText || p?.raw_text || "";
  if (!full.trim()) return c.json({ error: "还没有可总结的内容" }, 400);

  db.upsertPerspective(id, role, full);
  db.confirmGuideStory(id, role);
  db.enqueueAiJob(id, "summary", role);
  wakeAiWorker();
  return c.json({ queued: true }, 202);
});

// 用户可以随时结束潜谈，不生成报告或表达。
api.post("/events/:id/guide/end", (c) => {
  const id = c.req.param("id");
  const role = getSessionRole(c, id);
  if (role !== "a" && role !== "b") return c.json({ error: "无权限执行此操作" }, 403);
  const state = role === "a" ? "a_guiding" : "b_guiding";
  const auth = requireRole(c, id, role, [state]);
  if (!auth.ok) return c.json({ error: auth.error }, auth.status);
  if (!db.endGuideSession(id, role)) return c.json({ error: "状态已变化，请刷新" }, 409);
  return c.json({ state: "closed" });
});

// 摘要出现后如果用户发现自己还没说够，可以无损回到潜谈。
api.post("/events/:id/summary/continue", (c) => {
  const id = c.req.param("id");
  const role = getSessionRole(c, id);
  if (role !== "a" && role !== "b") return c.json({ error: "无权限执行此操作" }, 403);
  const expected = role === "a" ? "a_summary" : "b_summary";
  const auth = requireRole(c, id, role, [expected]);
  if (!auth.ok) return c.json({ error: auth.error }, auth.status);
  if (db.getUnresolvedAiJob(id)) return c.json({ error: "上一项理解任务还没有完成" }, 409);
  if (!db.reopenSummaryToGuiding(id, role)) {
    return c.json({ error: "状态已变化，请刷新" }, 409);
  }
  return c.json({ state: role === "a" ? "a_guiding" : "b_guiding" });
});

// 2) A 编辑并确认摘要
api.post("/events/:id/summary/confirm", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  const edited = body.edited as NvcSummary | undefined;
  const auth = requireRole(c, id, "a", ["a_summary"]);
  if (!auth.ok) return c.json({ error: auth.error }, auth.status);
  if(auth.ev.risk_level!=="none"||(auth.ev.a_user_id&&auth.ev.a_conversation_id&&privateCore.conversationHasActiveRisk(auth.ev.a_user_id,auth.ev.a_conversation_id)))return c.json({error:"当前潜谈含有尚未解除的安全风险，暂不能提交邀请",code:"ACTIVE_SAFETY_RISK"},409);
  if (
    auth.ev.invite_mode === "partner_direct" &&
    auth.ev.a_user_id &&
    !db.getActivePartnerUserId(auth.ev.a_user_id)
  ) {
    return c.json({ error: "请先在首页完成伴侣绑定；你的私密聊天和摘要都会保留" }, 409);
  }

  if (edited) {
    const clean = {
      observation: String(edited.observation ?? "").trim(),
      feelings: Array.isArray(edited.feelings) ? edited.feelings.map(String) : [],
      needs: Array.isArray(edited.needs) ? edited.needs.map(String) : [],
      request: String(edited.request ?? "").trim(),
    };
    db.setSummary(id, "a", JSON.stringify(clean));
  }
  db.confirmSummary(id, "a");
  if (!db.transition(id, "a_summary", "waiting_b")) {
    return c.json({ error: "状态已变化，请刷新" }, 409);
  }
  const partnerTargeted = auth.ev.a_user_id
    ? !!db.targetActivePartnerForEvent(id, auth.ev.a_user_id)
    : false;
  return c.json({
    code: auth.ev.invite_mode === "legacy_code" ? auth.ev.code : undefined,
    partnerTargeted,
  });
});

// 5) B 编辑并确认摘要 → 合并
api.post("/events/:id/b-summary/confirm", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  const edited = body.edited as NvcSummary | undefined;
  const auth = requireRole(c, id, "b", ["b_summary"]);
  if (!auth.ok) return c.json({ error: auth.error }, auth.status);
  if(auth.ev.risk_level!=="none"||db.eventHasActivePrivateRisk(id))return c.json({error:"当前潜谈含有尚未解除的安全风险，暂不能进入共同理解",code:"ACTIVE_SAFETY_RISK"},409);

  if (db.getUnresolvedAiJob(id)) {
    return c.json({ error: "上一项理解任务还没有完成" }, 409);
  }

  const finalSummary = edited
    ? {
      observation: String(edited.observation ?? "").trim(),
      feelings: Array.isArray(edited.feelings) ? edited.feelings.map(String) : [],
      needs: Array.isArray(edited.needs) ? edited.needs.map(String) : [],
      request: String(edited.request ?? "").trim(),
    }
    : null;
  const b = db.getPerspective(id, "b");
  const bSummary = finalSummary ?? (b?.summary ? (JSON.parse(b.summary) as NvcSummary) : null);
  const a = db.getPerspective(id, "a");
  if (!a?.summary || !bSummary) return c.json({ error: "摘要缺失" }, 409);
  if (finalSummary) db.setSummary(id, "b", JSON.stringify(finalSummary));
  db.confirmSummary(id, "b");
  db.enqueueAiJob(id, "merge_initial", "b");
  wakeAiWorker();
  return c.json({ queued: true }, 202);
});

// 6) 双方纠偏 + 确认共同理解（纠偏会重新生成）
api.post("/events/:id/merged/confirm", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)
    || (Object.hasOwn(body, "correction") && typeof body.correction !== "string")) {
    return c.json({ bothConfirmed: false, regenerated: false, error: "共同理解确认请求无效" }, 400);
  }
  const correction = body.correction as string | undefined;
  const auth = requireParticipant(c, id, ["merged"]);
  if (!auth.ok) {
    return c.json(
      { bothConfirmed: false, regenerated: false, error: auth.error },
      auth.status
    );
  }

  if (auth.ev.risk_level !== "none" || db.eventHasActivePrivateRisk(id)) {
    return c.json({ bothConfirmed: false, regenerated: false, error: "当前潜谈存在未解除的安全状态，暂不能继续共同理解", code: "ACTIVE_SAFETY_RISK" }, 409);
  }

  const currentMerged = db.getMerged(id);
  if (!Number.isInteger(body.expectedVersion) || !currentMerged || currentMerged.version !== body.expectedVersion) {
    return c.json(
      { bothConfirmed: false, regenerated: false, error: "共同理解已更新，请刷新后再确认", stale: true, version: currentMerged?.version ?? null },
      409
    );
  }

  if (!db.mergedReportIsCurrent(id)) {
    return c.json(
      { bothConfirmed: false, regenerated: false, error: "共同理解正在重新整理，完成前不能确认旧版本" },
      409
    );
  }

  if (db.getUnresolvedAiJob(id)) {
    return c.json(
      { bothConfirmed: false, regenerated: false, error: "共同理解仍在生成，请稍等" },
      409
    );
  }

  if (correction && correction.trim()) {
    const a = db.getPerspective(id, "a");
    const b = db.getPerspective(id, "b");
    if (!a?.summary || !b?.summary) {
      return c.json(
        { bothConfirmed: false, regenerated: false, error: "摘要缺失" },
        409
      );
    }
    const nextCorrection = correction.trim();
    try {
      db.acceptMergeCorrection(id, auth.role, nextCorrection);
    } catch {
      return c.json(
        { bothConfirmed: false, regenerated: false, queued: false, error: "纠偏未能保存并排队，请稍后重试" },
        503
      );
    }
    // The database helper commits correction, confirmation invalidation, and
    // the durable job together before the worker can observe the job.
    wakeAiWorker();
    return c.json({ bothConfirmed: false, regenerated: true, queued: true }, 202);
  }

  if (!db.confirmMerged(id, auth.role, Number(body.expectedVersion))) {
    const latest = db.getMerged(id);
    return c.json({ bothConfirmed: false, regenerated: false, error: "共同理解已更新，请刷新后再确认", stale: true, version: latest?.version ?? null }, 409);
  }
  const m = db.getMerged(id);
  const both = !!(m && m.a_confirmed && m.b_confirmed);
  if (both) db.transition(id, "merged", "agreement_proposed");
  return c.json({ bothConfirmed: both, regenerated: false });
});

// AI 后台任务失败后重试：沿用已保存的原消息/摘要/纠偏，不要求用户重新输入。
api.post("/events/:id/ai/retry", async (c) => {
  const id = c.req.param("id");
  const role = getSessionRole(c, id);
  if (role !== "a" && role !== "b") return c.json({ error: "无权限执行此操作" }, 403);
  const visibleJob = db.getVisibleAiJob(id, role);
  if (visibleJob?.error_code === "AI_RESULT_UNKNOWN") {
    return c.json({ error: visibleJob.error, code: "AI_RESULT_UNKNOWN", retryAllowed: false }, 409);
  }
  const body = await c.req.json().catch(() => ({}));
  const expectedJobId = typeof body?.expectedJobId === "string" ? body.expectedJobId : undefined;
  const expectedAttempt = Number.isInteger(body?.expectedAttempt) ? body.expectedAttempt as number : undefined;
  if (
    !visibleJob || visibleJob.status !== "failed" ||
    expectedJobId !== visibleJob.id || expectedAttempt !== visibleJob.attempts
  ) {
    return c.json({ error: "任务状态已变化，请刷新查看最新状态", code: "AI_JOB_CHANGED", retryAllowed: false }, 409);
  }
  if (!db.retryVisibleAiJob(id, role, expectedJobId, expectedAttempt)) {
    return c.json({ error: "任务状态已变化，请刷新查看最新状态", code: "AI_JOB_CHANGED", retryAllowed: false }, 409);
  }
  wakeAiWorker();
  return c.json({ queued: true }, 202);
});

// 7) 双方各自确认行动方针
api.post("/events/:id/agreement", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  const choice = String(body.choice ?? "").trim();
  const auth = requireParticipant(c, id, ["agreement_proposed"]);
  if (!auth.ok) return c.json({ done: false, error: auth.error }, auth.status);
  if (auth.ev.risk_level !== "none" || db.eventHasActivePrivateRisk(id)) return c.json({ done: false, error: "当前潜谈存在未解除的安全状态，暂不能继续共同理解", code: "ACTIVE_SAFETY_RISK" }, 409);
  if (!choice) return c.json({ done: false, error: "请选择你的行动" }, 400);

  db.setChoice(id, auth.role, choice);
  const choices = db.getChoices(id);
  if (choices.a && choices.b) {
    db.markAgreementDone(id);
    db.transition(id, "agreement_proposed", "done");
    return c.json({ done: true });
  }
  return c.json({ done: false });
});

// 8) 双方分别提交复访
api.post("/events/:id/review", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  const auth = requireParticipant(c, id, ["done"]);
  if (!auth.ok) return c.json({ bothReviewed: false, error: auth.error }, auth.status);
  if (auth.ev.risk_level !== "none" || db.eventHasActivePrivateRisk(id)) return c.json({ bothReviewed: false, error: "当前潜谈存在未解除的安全状态，暂不能继续共同复盘", code: "ACTIVE_SAFETY_RISK" }, 409);

  const agreement = db.getAgreement(id);
  if (agreement?.due_at && Date.now() < agreement.due_at) {
    return c.json({ bothReviewed: false, error: "复访尚未到期" }, 409);
  }

  const clean = {
    executed: String(body.executed ?? "").trim(),
    effect: String(body.effect ?? "").trim(),
    next: String(body.next ?? "").trim(),
  };
  if (!clean.executed || !clean.next) {
    return c.json({ bothReviewed: false, error: "请填写复访内容" }, 400);
  }
  db.setReview(id, auth.role, JSON.stringify(clean));
  if (db.bothReviewed(id)) {
    db.transition(id, "done", "completed");
    return c.json({ bothReviewed: true });
  }
  return c.json({ bothReviewed: false });
});

// B 拒绝
api.post("/events/:id/decline", (c) => {
  const id = c.req.param("id");
  const event=db.getEvent(id);
  if(event?.invite_mode==="partner_direct") {
    const account=requireAccount(c); if(!account.ok)return c.json({ok:false,error:account.error},account.status);
    if(event.state==="waiting_b"&&event.partner_target_user_id===account.user.id) {
      return db.declinePartnerEventInvite(id,account.user.id)
        ? c.json({ok:true,state:"declined"})
        : c.json({ok:false,error:"邀请状态已变化，请刷新"},409);
    }
    if(event.b_user_id===account.user.id&&["b_guiding","b_expressing","b_summary"].includes(event.state)) {
      if(!db.transition(id,event.state,"declined"))return c.json({ok:false,error:"邀请状态已变化，请刷新"},409);
      db.cancelVisibleAiJob(id,"b");
      db.db.prepare(`UPDATE events SET b_conversation_id=NULL WHERE id=?`).run(id);
      db.db.prepare(`UPDATE private_conversations SET linked_event_id=NULL,linked_side=NULL WHERE linked_event_id=? AND linked_side='b'`).run(id);
      return c.json({ok:true,state:"declined"});
    }
    return c.json({ok:false,error:"邀请不存在或无权访问"},404);
  }
  const auth = requireRole(c, id, "b", ["waiting_b", "b_guiding", "b_expressing"]);
  if (!auth.ok) return c.json({ ok: false, error: auth.error }, auth.status);
  db.transition(id, auth.ev.state, "declined");
  return c.json({ ok: true });
});

// A 撤回
api.post("/events/:id/withdraw", (c) => {
  const id = c.req.param("id");
  const auth = requireRole(c, id, "a", ["waiting_b"]);
  if (!auth.ok) return c.json({ ok: false, error: auth.error }, auth.status);
  if (!db.transition(id, "waiting_b", "cancelled")) {
    return c.json({ ok: false, error: "状态已变化，请刷新" }, 409);
  }
  db.clearPartnerTargetForEvent(id);
  return c.json({ ok: true });
});

api.post("/events/:id/sharing/revoke", (c) => {
  const account = requireAccount(c);
  if (!account.ok) return c.json({ ok: false, error: account.error }, account.status);
  const id = c.req.param("id");
  const result = db.revokeEventSharingConsent(id, account.user.id);
  if (result === "not_found" || result === "not_participant") {
    return c.json({ ok: false, error: "这次分享不存在或你没有撤回权限" }, 404);
  }
  if (result === "not_shared") return c.json({ ok: false, error: "当前没有可撤回的已分享内容" }, 409);
  const event = db.getEvent(id)!;
  const role = event.a_user_id === account.user.id ? "a" : "b";
  const conversationId = role === "a" ? event.a_conversation_id : event.b_conversation_id;
  const ownConversationId = conversationId && privateCore.getConversationById(account.user.id, conversationId)
    ? conversationId
    : null;
  return c.json({ ok: true, state: "sharing_revoked", ownConversationId });
});

// 撤回后继续私密潜谈：保留原消息，但旧摘要不再视为有效。
api.post("/events/:id/withdraw/continue", (c) => {
  const id = c.req.param("id");
  const auth = requireRole(c, id, "a", ["cancelled"]);
  if (!auth.ok) return c.json({ error: auth.error }, auth.status);
  if (!db.reopenCancelledToGuiding(id)) {
    return c.json({ error: "状态已变化，请刷新" }, 409);
  }
  db.addGuideMessage(
    id,
    "a",
    "ai",
    "邀请已经撤回了，我们可以从这里接着聊。你现在最想补充、修正，或者重新想清楚的是哪一部分？"
  );
  return c.json({ state: "a_guiding" });
});

// 撤回后沿用本人已确认的表达重新提交，并轮换为全新邀请码。
api.post("/events/:id/withdraw/resubmit", (c) => {
  const id = c.req.param("id");
  const auth = requireRole(c, id, "a", ["cancelled"]);
  if (!auth.ok) return c.json({ error: auth.error }, auth.status);
  if(auth.ev.risk_level!=="none"||(auth.ev.a_user_id&&auth.ev.a_conversation_id&&privateCore.conversationHasActiveRisk(auth.ev.a_user_id,auth.ev.a_conversation_id)))return c.json({error:"当前潜谈含有尚未解除的安全风险，暂不能重新邀请",code:"ACTIVE_SAFETY_RISK"},409);
  if (auth.ev.a_user_id && !db.getActivePartnerUserId(auth.ev.a_user_id)) {
    return c.json({ error: "请先完成伴侣绑定，再重新邀请" }, 409);
  }
  const code = db.resubmitCancelledInvite(id);
  if (!code) {
    return c.json({ error: "原表达还没有准备完成，请先继续聊聊再重新提交" }, 409);
  }
  const partnerTargeted = auth.ev.a_user_id
    ? !!db.targetActivePartnerForEvent(id, auth.ev.a_user_id)
    : false;
  return c.json({ state: "waiting_b", code: auth.ev.invite_mode === "legacy_code" ? code : undefined, partnerTargeted });
});

// 已过期但尚未被使用的邀请码可以直接刷新，不必重新整理本人表达。
api.post("/events/:id/invite/refresh", (c) => {
  const id = c.req.param("id");
  const auth = requireRole(c, id, "a", ["waiting_b"]);
  if (!auth.ok) return c.json({ error: auth.error }, auth.status);
  const code = db.refreshExpiredInvite(id, Date.now() - INVITE_TTL_MS);
  if (!code) {
    return c.json({ error: "邀请码仍然有效、已经被使用，或状态已经变化" }, 409);
  }
  return c.json({ state: "waiting_b", code });
});

// ---------- 读操作（数据最小化，逻辑与前端 page.tsx 一致） ----------

api.get("/events/:id", (c) => {
  const id = c.req.param("id");
  const ev = db.getEvent(id);
  const role = getSessionRole(c, id);
  if (!ev || !role) return c.json({ error: "这次对话不存在或你没有访问权限" }, 404);
  const user = getCurrentUser(c);
  const linkedConversationId = role === "a"
    ? ev.a_conversation_id
    : role === "b"
      ? ev.b_conversation_id
      : null;
  const ownConversationId = user && linkedConversationId
    && privateCore.getConversationById(user.id, linkedConversationId)
    ? linkedConversationId
    : null;
  const pa = db.getPerspective(id, "a");
  const pb = db.getPerspective(id, "b");
  const m = db.getMerged(id);
  const agr = db.getAgreement(id);
  const reviews = db.getReviews(id);

  const isParticipant = role === "a" || role === "b";
  const sharingRevoked = ev.state === "sharing_revoked";
  const sharedSafetyPaused = isParticipant && !sharingRevoked && ["a_summary", "waiting_b", "b_guiding", "b_summary", "merged", "agreement_proposed", "done"].includes(ev.state)
    && (ev.risk_level !== "none" || db.eventHasActivePrivateRisk(id));
  const isShared =
    isParticipant && !sharingRevoked && ["merged", "agreement_proposed", "done", "completed"].includes(ev.state);
  const isAgreement =
    isParticipant && !sharingRevoked && ["agreement_proposed", "done", "completed"].includes(ev.state);
  const isCompleted = ev.state === "completed" && !sharingRevoked;
  const ownStory = isParticipant ? storyFor(id, role as "a" | "b") : null;
  const guideSession = isParticipant
    ? db.getGuideSession(id, role as "a" | "b")
    : undefined;
  const aiJob = isParticipant ? db.getVisibleAiJob(id, role as "a" | "b") : undefined;
  const mergedRecovery = isParticipant
    ? db.getMergedRecovery(id, role as "a" | "b", user?.id ?? null, getSessionToken(c, id))
    : null;
  const mergedCurrent = isShared && !sharedSafetyPaused && db.mergedReportIsCurrent(id) && mergedRecovery?.kind !== "history";
  const mergedContent = mergedCurrent && m?.content
    ? db.scopeMergedForRole(JSON.parse(m.content) as MergedUnderstanding, role as "a" | "b")
    : null;
  const inviteStartedAt = ev.invite_created_at ?? ev.created_at;
  const inviteStatus =
    role !== "a"
      ? null
      : sharingRevoked
        ? "revoked"
      : ev.b_user_id || ev.b_token
        ? "activated"
        : ev.state === "cancelled"
          ? "withdrawn"
          : ev.state === "waiting_b" && Date.now() - inviteStartedAt > INVITE_TTL_MS
            ? "expired"
            : ev.state === "waiting_b"
              ? "waiting"
              : null;

  return c.json({
    id,
    title: sharingRevoked ? "分享已停止" : ev.title,
    code: !sharingRevoked && role === "a" && ev.invite_mode === "legacy_code" ? ev.code : "",
    inviteMode: ev.invite_mode,
    inviteStatus,
    ownConversationId,
    partnerTarget: !sharingRevoked && role === "a" ? db.getPartnerTarget(id) : null,
    state: ev.state,
    sharingRevoked,
    sharedSafetyPaused,
    mergedVersion: mergedCurrent ? (m?.version ?? null) : null,
    risk: ev.risk_level === "none" || (sharingRevoked && ev.risk_side !== role)
      ? "none"
      : ev.risk_side === role ? ev.risk_level : "private_safety",
    role,
    aSummary: !sharingRevoked && (role === "a" || isShared) && pa?.summary ? JSON.parse(pa.summary) : null,
    bSummary: !sharingRevoked && (role === "b" || isShared) && pb?.summary ? JSON.parse(pb.summary) : null,
    aConfirmed: isParticipant && !sharingRevoked && !!pa?.summary_confirmed,
    bConfirmed: isParticipant && !sharingRevoked && !!pb?.summary_confirmed,
    aCorrection: !sharingRevoked && role === "a" ? (pa?.correction ?? null) : null,
    bCorrection: !sharingRevoked && role === "b" ? (pb?.correction ?? null) : null,
    merged: mergedContent,
    mergedRecovery: sharedSafetyPaused ? null : mergedRecovery,
    mergedAConfirmed: mergedCurrent && !!m?.a_confirmed,
    mergedBConfirmed: mergedCurrent && !!m?.b_confirmed,
    choices: isAgreement && !sharedSafetyPaused ? db.getChoices(id) : {},
    guideMessages: role === "a" || role === "b" ? db.getGuideMessages(id, role) : [],
    guideStage: guideSession?.stage ?? "story",
    guideProgress: ownStory ? guideProgress(ownStory) : guideProgress(emptyStoryMap()),
    storyMap: ownStory,
    storyConfirmed: isParticipant && !!guideSession?.story_confirmed,
    aiJobKind: sharingRevoked ? null : (aiJob?.kind ?? null),
    aiJobId: isParticipant && !sharingRevoked ? (aiJob?.id ?? null) : null,
    aiJobAttempt: isParticipant && !sharingRevoked ? (aiJob?.attempts ?? null) : null,
    aiJobStatus: sharingRevoked ? "idle" : (aiJob?.status ?? "idle"),
    aiJobError: !sharingRevoked && aiJob?.status === "failed" ? aiJob.error : null,
    aiJobErrorCode: isParticipant && !sharingRevoked && aiJob?.status === "failed" ? aiJob.error_code : null,
    aiJobRetryAllowed: isParticipant && !sharingRevoked && aiJob?.status === "failed" && aiJob.error_code !== "AI_RESULT_UNKNOWN"
      && ((aiJob.kind !== "merge_initial" && aiJob.kind !== "merge_correction") || db.aiJobInputsAreAllowed(aiJob)),
    dueAt: isParticipant && !sharingRevoked ? (agr?.due_at ?? null) : null,
    reviewAvailable: isParticipant && !sharingRevoked && !sharedSafetyPaused && (!agr?.due_at || Date.now() >= agr.due_at),
    aReview: !sharingRevoked && isParticipant && (role === "a" || isCompleted) && reviews.a ? JSON.parse(reviews.a) : null,
    bReview: !sharingRevoked && isParticipant && (role === "b" || isCompleted) && reviews.b ? JSON.parse(reviews.b) : null,
  });
});

// Legacy merged reports can be regenerated only by an explicit participant action.
api.post("/events/:id/merged/recover", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)
    || Object.keys(body).some((key) => key !== "expectedVersion") || !Number.isInteger(body.expectedVersion)) {
    return c.json({ error: "恢复请求无效" }, 400);
  }
  const auth = requireParticipant(c, id, ["merged"]);
  if (!auth.ok) return c.json({ error: auth.error }, auth.status);
  const user = getCurrentUser(c);
  let result: db.RecoverMergedResult;
  try {
    result = db.recoverMergedReport(
      id,
      auth.role,
      user?.id ?? null,
      getSessionToken(c, id),
      Number(body.expectedVersion)
    );
  } catch {
    return c.json({ error: "恢复任务未能保存，请稍后重试", code: "RECOVERY_NOT_SAVED" }, 503);
  }
  if (result.status === "stale") {
    return c.json({ error: "共同理解已更新，请刷新后重试", code: "STALE_VERSION", expectedVersion: result.expectedVersion }, 409);
  }
  if (result.status === "unavailable") {
    return c.json({ error: result.view?.reason ?? "当前状态无法恢复共同理解", code: "RECOVERY_UNAVAILABLE" }, 409);
  }
  wakeAiWorker();
  return c.json({ queued: true, jobId: result.job.id, status: result.job.status }, 202);
});

export default api;
