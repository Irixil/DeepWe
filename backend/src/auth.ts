// 后端统一授权：事件存在、cookie 令牌有效、角色匹配、状态允许。
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import crypto from "node:crypto";
import { promisify } from "node:util";
import * as db from "./db.js";
import type { EventState } from "./db.js";

export type Role = "a" | "b";

export type AuthResult =
  | { ok: true; ev: db.EventRow; role: Role }
  | { ok: false; error: string; status: 403 | 404 | 409 };

export type AccountAuthResult =
  | { ok: true; user: db.UserRow }
  | { ok: false; error: string; status: 401 | 403 };

const ACCOUNT_COOKIE = "dw_account";
const ACCOUNT_SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const PASSWORD_KEY_LENGTH = 64;
const scryptAsync = promisify(crypto.scrypt);

function sessionTokenHash(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export async function hashPassword(
  password: string
): Promise<{ passwordHash: string; passwordSalt: string }> {
  const passwordSalt = crypto.randomBytes(16).toString("hex");
  const derived = (await scryptAsync(password, passwordSalt, PASSWORD_KEY_LENGTH)) as Buffer;
  return { passwordHash: derived.toString("hex"), passwordSalt };
}

export async function verifyPassword(
  password: string,
  passwordHash: string,
  passwordSalt: string
): Promise<boolean> {
  try {
    const derived = (await scryptAsync(password, passwordSalt, PASSWORD_KEY_LENGTH)) as Buffer;
    const expected = Buffer.from(passwordHash, "hex");
    return expected.length === derived.length && crypto.timingSafeEqual(expected, derived);
  } catch {
    return false;
  }
}

export function getCurrentUser(c: Context): db.UserRow | undefined {
  const token = getCookie(c, ACCOUNT_COOKIE);
  if (!token) return undefined;
  return db.getUserBySessionTokenHash(sessionTokenHash(token));
}

export function requireAccount(c: Context): AccountAuthResult {
  const user = getCurrentUser(c);
  return user
    ? { ok: true, user }
    : { ok: false, error: "请先登录账号", status: 401 };
}

export function requireAdmin(c: Context): AccountAuthResult {
  const account = requireAccount(c);
  if (!account.ok) return account;
  const configuredOwnerId = process.env.DEEPWE_OWNER_USER_ID?.trim();
  return configuredOwnerId && account.user.id === configuredOwnerId
    ? account
    : { ok: false, error: "管理员权限不可用或当前账号无权访问", status: 403 };
}

export function startAccountSession(c: Context, userId: string): void {
  const token = crypto.randomBytes(32).toString("hex");
  db.createAccountSession(userId, sessionTokenHash(token), Date.now() + ACCOUNT_SESSION_MS);
  setCookie(c, ACCOUNT_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: ACCOUNT_SESSION_MS / 1000,
  });
}

export function endAccountSession(c: Context): void {
  const token = getCookie(c, ACCOUNT_COOKIE);
  if (token) db.deleteAccountSession(sessionTokenHash(token));
  deleteCookie(c, ACCOUNT_COOKIE, { path: "/" });
}

// 用户首次登录时，把当前浏览器仍持有令牌的旧版匿名事件归到账号下。
export function claimLegacyEventsFromCookies(c: Context, userId: string): number {
  const raw = c.req.header("Cookie") ?? "";
  let claimed = 0;
  for (const part of raw.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    const match = /^dw_([0-9a-f-]{36})$/i.exec(name);
    if (!match) continue;
    const token = decodeURIComponent(part.slice(separator + 1).trim());
    if (db.claimLegacyEvent(match[1], userId, token)) claimed += 1;
  }
  return claimed;
}

export function getSessionToken(c: Context, eventId: string): string | null {
  return getCookie(c, `dw_${eventId}`) ?? null;
}

export function getSessionRole(c: Context, eventId: string): Role | null {
  const ev = db.getEvent(eventId);
  if (!ev) return null;
  const user = getCurrentUser(c);
  if (user?.id === ev.a_user_id) return "a";
  if (user?.id === ev.b_user_id) return "b";

  const token = getSessionToken(c, eventId);
  if (!token) return null;
  // 已归属账号的一侧不能再仅凭旧 Cookie 令牌进入，退出登录会真正失去访问权。
  if (!ev.a_user_id && token === ev.a_token) return "a";
  if (!ev.b_user_id && token === ev.b_token) return "b";
  return null;
}

export function requireRole(
  c: Context,
  eventId: string,
  role: Role,
  allowedStates: EventState[]
): AuthResult {
  const ev = db.getEvent(eventId);
  if (!ev) return { ok: false, error: "事件不存在", status: 404 };
  const sessionRole = getSessionRole(c, eventId);
  if (sessionRole !== role) return { ok: false, error: "无权限执行此操作", status: 403 };
  if (!allowedStates.includes(ev.state)) {
    return { ok: false, error: "当前状态不允许此操作", status: 409 };
  }
  return { ok: true, ev, role: sessionRole };
}

export function requireParticipant(
  c: Context,
  eventId: string,
  allowedStates: EventState[]
): AuthResult {
  const ev = db.getEvent(eventId);
  if (!ev) return { ok: false, error: "事件不存在", status: 404 };
  const sessionRole = getSessionRole(c, eventId);
  if (sessionRole !== "a" && sessionRole !== "b") {
    return { ok: false, error: "无权限执行此操作", status: 403 };
  }
  if (!allowedStates.includes(ev.state)) {
    return { ok: false, error: "当前状态不允许此操作", status: 409 };
  }
  return { ok: true, ev, role: sessionRole };
}
