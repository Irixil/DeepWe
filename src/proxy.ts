import { NextRequest, NextResponse } from "next/server";
import assets from "../config/public-assets.json";

const publishedAssets = new Set(assets.map(file => `/${file}`));

export function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  if (/(?:^|\/)(?:\.env(?:\.[^/]*)?|\.git|\.data|backend|src|docs)(?:\/|$)/i.test(pathname) || /\.(?:map|db|sqlite|sqlite3|psd|ai|sketch|fig|zip|tar|gz)$/i.test(pathname)) {
    return new NextResponse(null, { status: 404, headers: { "Cache-Control": "no-store" } });
  }
  // 外站防盗链仅减少普通引用，不能代替私有文件的登录鉴权。
  if (pathname.startsWith("/brand/") || pathname === "/_next/image") {
    const assetPath = pathname === "/_next/image" ? request.nextUrl.searchParams.get("url") : pathname;
    if (process.env.NODE_ENV === "production" && (!assetPath || !publishedAssets.has(assetPath))) {
      return new NextResponse(null, { status: 404, headers: { "Cache-Control": "no-store" } });
    }
    const referer = request.headers.get("referer");
    let foreignReferer = false;
    if (referer) {
      // Next会把127.0.0.1规范为localhost；用原Host避免误伤本站浏览器。
      try { foreignReferer = new URL(referer).host !== (request.headers.get("host") || request.nextUrl.host); }
      catch { foreignReferer = true; }
    }
    if (request.headers.get("sec-fetch-site") === "cross-site" || foreignReferer) {
      return new NextResponse(null, { status: 403, headers: { "Cache-Control": "no-store" } });
    }
    const response = NextResponse.next();
    response.headers.set("Cross-Origin-Resource-Policy", "same-origin");
    // 展示图可在本人的浏览器缓存一天；禁止共享CDN缓存，避免跨站绕过检查。
    response.headers.set("Cache-Control", "private, max-age=86400");
    // Next图片优化器会自行设置Cache-Control；另行禁止共享CDN缓存。
    response.headers.set("CDN-Cache-Control", "no-store");
    response.headers.set("Surrogate-Control", "no-store");
    return response;
  }
  return NextResponse.next();
}
