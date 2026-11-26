// 시황판 (Cloudflare Pages). 정적 화면을 내보내고 /mcp 조회 요청만 KIS 조회 전용 서버로 넘긴다.
// 주문·계좌 기능은 없다. 같은 사이트에서 온 요청만 넘긴다.
const UPSTREAM = "https://kis-readonly-mcp.bummagic.workers.dev";
const SEC = {
  "x-robots-tag": "noindex, nofollow",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};
const CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) {
      const origin = request.headers.get("origin");
      if (request.method !== "POST" || origin !== url.origin) {
        return new Response("Forbidden", { status: 403, headers: SEC });
      }
      const target = UPSTREAM + url.pathname + url.search;
      const headers = new Headers(request.headers);
      headers.delete("origin");
      headers.delete("cookie");
      const init = { method: "POST", headers, body: request.body };
      const res = env.KIS ? await env.KIS.fetch(target, init) : await fetch(target, init);
      const out = new Response(res.body, res);
      for (const [k, v] of Object.entries(SEC)) out.headers.set(k, v);
      return out;
    }
    const res = await env.ASSETS.fetch(request);
    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(SEC)) out.headers.set(k, v);
    if ((out.headers.get("content-type") || "").includes("text/html")) {
      out.headers.set("content-security-policy", CSP);
      out.headers.set("cache-control", "no-cache");
    }
    return out;
  },
};
