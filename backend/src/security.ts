import type { MiddlewareHandler } from "hono";
import { createHash } from "node:crypto";

const productionOrigins = new Set([
  "https://s2fslv06rel2qvptljhke.apigateway-cn-beijing.volceapi.com",
  "https://s1d0d9s5n775rt5i5ulse.apigateway-cn-beijing.volceapi.com",
]);
const attempts = new Map<string, { count: number; until: number }>();
const windowMs = 10 * 60 * 1000;

function allowedOrigin(origin: string): boolean {
  if (productionOrigins.has(origin)) return true;
  return process.env.NODE_ENV !== "production" &&
    /^http:\/\/(localhost|127\.0\.0\.1):(3000|3001)$/.test(origin);
}

// ponytail: 单实例内存限流，实例重启会清空；多实例上线前迁移到共享限流存储。
function takeAttempt(key: string, limit: number, duration: number): boolean {
  const now = Date.now();
  for (const [id, bucket] of attempts) if (bucket.until <= now) attempts.delete(id);
  let bucket = attempts.get(key);
  if (!bucket) {
    if (attempts.size >= 5000) return false;
    bucket = { count: 0, until: now + duration };
    attempts.set(key, bucket);
  }
  return ++bucket.count <= limit;
}

export const security: MiddlewareHandler = async (c, next) => {
  c.header("Cache-Control", "private, no-store, max-age=0");
  c.header("CDN-Cache-Control", "no-store");
  c.header("Pragma", "no-cache");
  c.header("Vary", "Cookie, Origin");
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
  c.header("Referrer-Policy", "same-origin");
  if (process.env.NODE_ENV === "production") c.header("Strict-Transport-Security", "max-age=31536000");

  if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
    const origin = c.req.header("Origin");
    if (c.req.header("Sec-Fetch-Site") === "cross-site" || (origin && !allowedOrigin(origin))) {
      return c.json({ error: "请求来源无效，请回到 DeepWe 页面操作" }, 403);
    }
    const contentType = c.req.header("Content-Type");
    if (contentType && !/^application\/json(?:;|$)/i.test(contentType)) {
      return c.json({ error: "不支持的请求格式" }, 415);
    }
  }

  if (c.req.method === "POST" && ["/auth/login", "/auth/register", "/auth/reset-password"].includes(c.req.path)) {
    if (!takeAttempt("auth-total", 300, 60 * 1000)) {
      c.header("Retry-After", "60");
      return c.json({ error: "尝试过于频繁，请稍后再试" }, 429);
    }
    const input = await c.req.raw.clone().json().catch(() => ({}));
    const email = typeof input?.email === "string" ? input.email.trim().toLowerCase().slice(0, 254) : "";
    const hash = createHash("sha256").update(email).digest("hex");
    const limit = c.req.path === "/auth/login" ? 20 : 6;
    if (!takeAttempt(`${c.req.path}:${hash}`, limit, windowMs)) {
      c.header("Retry-After", String(windowMs / 1000));
      return c.json({ error: "尝试过于频繁，请稍后再试" }, 429);
    }
  }
  await next();
};
