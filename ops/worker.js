// Chatter 中转（Cloudflare Worker）：把请求原样转发给你的 Supabase 项目，包括实时通道（WebSocket）。
// 只放行 Supabase 的几个接口路径，别人拿去当通用代理用不了。
const TARGET = 'https://uaoiqbxptnbrvkzjwguc.supabase.co';
const ALLOW = ['/auth/v1/', '/rest/v1/', '/realtime/v1/', '/storage/v1/'];

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/' || url.pathname === '/ping') {
      return new Response('chatter proxy ok', { headers: { 'content-type': 'text/plain; charset=utf-8', 'access-control-allow-origin': '*' } });
    }
    if (!ALLOW.some(p => url.pathname.startsWith(p))) {
      return new Response('not found', { status: 404 });
    }
    const upstream = new Request(TARGET + url.pathname + url.search, request);
    const resp = await fetch(upstream);
    if (request.headers.get('upgrade') === 'websocket') return resp;     // 实时通道直接交回
    const out = new Response(resp.body, resp);
    out.headers.set('access-control-allow-origin', '*');
    return out;
  }
};
