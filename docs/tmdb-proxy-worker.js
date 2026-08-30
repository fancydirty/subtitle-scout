/**
 * TMDB 反代 Cloudflare Worker：一个域名同时反代 TMDB API 与图片，供大陆等直连不通的网络环境使用。
 * TMDB reverse proxy for Cloudflare Workers: one domain fronting both the TMDB API and images.
 *
 * 路由 / Routing:
 *   /t/p/*  -> https://image.tmdb.org/t/p/*   （图片 / images，CF 边缘缓存 1 天）
 *   其余    -> https://api.themoviedb.org/*    （API，/3/... 原样透传，query 里的 key 一并透传）
 *
 * 部署三步 / Deploy in three steps:
 *   1. `npx wrangler deploy docs/tmdb-proxy-worker.js --name tmdb-proxy --compatibility-date 2026-08-01`
 *      或在 Cloudflare dashboard 新建 Worker 后整段粘贴本文件。
 *      Or create a Worker in the Cloudflare dashboard and paste this file in.
 *   2. 给 Worker 绑定**自有域名**（Worker → Settings → Domains & Routes → Custom domain）。
 *      `*.workers.dev` 在大陆被墙——绑自定义域名不是可选项。
 *      Bind a custom domain you own; *.workers.dev itself is blocked in mainland China.
 *   3. 把域名填进 subtitle-scout（compose 的 environment）：
 *      Point subtitle-scout at it via compose environment:
 *        TMDB_BASE_URL: https://tmdb.example.com/3
 *        TMDB_IMAGE_BASE_URL: https://tmdb.example.com
 */
export default {
  async fetch(request) {
    const url = new URL(request.url);
    const isImage = url.pathname.startsWith("/t/p/");
    const upstream = new URL(
      url.pathname + url.search,
      isImage ? "https://image.tmdb.org" : "https://api.themoviedb.org",
    );

    // 只透传认证头（v4 Read Access Token 走 Authorization；v3 key 已在 query 里）。
    const headers = new Headers();
    const auth = request.headers.get("authorization");
    if (auth) headers.set("authorization", auth);
    const accept = request.headers.get("accept");
    if (accept) headers.set("accept", accept);

    // fetch 按 upstream 的主机名自动改写 Host；图片走 CF 边缘缓存。
    const response = await fetch(upstream, {
      method: request.method,
      headers,
      cf: isImage ? { cacheEverything: true, cacheTtl: 86400 } : undefined,
    });

    const out = new Response(response.body, response);
    out.headers.set("access-control-allow-origin", "*"); // 图片给浏览器直连用
    if (isImage) out.headers.set("cache-control", "public, max-age=86400");
    return out;
  },
};
