// 搜索服务器函数的检查：在本机用 Deno 跑 supabase/functions/chatter-search/index.ts，
// 数据库、登录服务、Serper、维基百科、各种网站全部换成假的（不联网、不花额度）。
// 用法：cd tests && CHATTER_TEST=1 deno run -A fn-search-test.ts
Deno.env.set('CHATTER_TEST', '1');
Deno.env.set('SUPABASE_URL', 'https://proj.supabase.co');
Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'service.jwt.key');
Deno.env.set('SERPER_API_KEY', 'serper-test-key');
// deno-lint-ignore no-explicit-any
type Any = any;
const UID = '11111111-1111-4111-8111-111111111111', TOK = 'aaa.bbb.ccc';
let CONF: Any = { per_user_day: 80, read_per_user_day: 300, month_cap: 2400 };
const cache = new Map<string, Any>(), counts = new Map<string, number>();
let rpcMissing = false, serperCalls = 0, wikiCalls = 0, serperMode = 'ok', siteCalls: string[] = [];
const gbk = (n: number) => { const a: number[] = []; for (let i = 0; i < n; i++) a.push(0xc4, 0xe3, 0xba, 0xc3); return a; };   // “你好”的 GBK 编码
const ascii = (s: string) => Array.from(new TextEncoder().encode(s));
const GBK_PAGE = new Uint8Array([...ascii('<html><head><meta charset="gbk"><title>T</title></head><body><nav>menu</nav><article><h1>'), ...gbk(3), ...ascii('</h1><p>'), ...gbk(90), ...ascii('</p><p>'), ...gbk(90), ...ascii('</p></article></body></html>')]);
const LONG = '这是一段很长的正文，用来让正文提取认出这是文章。'.repeat(12);
const UTF_PAGE = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>测试文章 - 测试站</title>
<meta property="og:site_name" content="测试站"><meta property="article:published_time" content="2026-11-01T08:00:00+08:00">
<script>alert(1)</script></head><body><header>顶栏 打开App阅读</header><nav>导航</nav>
<article><h1>测试文章</h1><p onclick="alert(2)" style="color:red" class="x">${LONG}</p>
<p><img src="data:image/gif;base64,R0lGOD" data-src="/img/a.jpg" onerror="alert(3)"> <a href="javascript:alert(4)">坏链接</a> <a href="/next" target="_blank">下一篇</a></p>
<iframe src="https://evil.example/"></iframe><p>${LONG}</p><table><thead><tr><th>项目</th><th>数量</th></tr></thead><tbody><tr><td>表格</td><td>1</td></tr><tr><td>第二行</td><td>2</td></tr><tr><td>第三行</td><td>3</td></tr></tbody></table></article>
<aside>推荐阅读 广告</aside><footer>版权</footer></body></html>`;
const realFetch = globalThis.fetch;
const J = (o: Any, st = 200, h: Record<string, string> = {}) => new Response(JSON.stringify(o), { status: st, headers: { 'content-type': 'application/json', ...h } });
globalThis.fetch = async (input: Any, init: Any = {}) => {
  const u = new URL(typeof input === 'string' ? input : input.url), m = (init.method || 'GET').toUpperCase();
  const H = new Headers(init.headers || {});
  if (u.host === 'proj.supabase.co') {
    if (H.get('apikey') !== 'service.jwt.key') return J({ msg: 'no key' }, 401);
    if (u.pathname === '/auth/v1/user') return H.get('authorization') === 'Bearer ' + TOK ? J({ id: UID }) : J({ msg: 'bad jwt' }, 403);
    if (H.get('authorization') !== 'Bearer service.jwt.key') return J({ msg: 'no auth' }, 401);
    if (u.pathname === '/rest/v1/app_config') return J([{ value: CONF }]);
    if (u.pathname === '/rest/v1/search_cache') {
      if (m === 'GET') { const k = (u.searchParams.get('k') || '').replace(/^eq\./, ''); return J(cache.has(k) ? [cache.get(k)] : []); }
      if (m === 'POST') { const b = JSON.parse(init.body); cache.set(b.k, { v: b.v, at: b.at }); return new Response(null, { status: 201 }); }
      if (m === 'DELETE') return new Response(null, { status: 204 });
    }
    if (u.pathname === '/rest/v1/search_usage' && m === 'DELETE') return new Response(null, { status: 204 });
    if (u.pathname === '/rest/v1/rpc/search_bump') {
      if (rpcMissing) return J({ code: 'PGRST202', message: 'Could not find the function' }, 404);
      const b = JSON.parse(init.body), k = b.p_uid + '|' + b.p_kind + '|' + b.p_month, n = counts.get(k) || 0;
      if (n >= b.p_limit) return J(-1);
      counts.set(k, n + 1); return J(n + 1);
    }
    return J({ msg: 'unknown ' + u.pathname }, 404);
  }
  if (u.host === 'google.serper.dev') {
    serperCalls++;
    if (H.get('x-api-key') !== 'serper-test-key') return J({ message: 'Unauthorized.', statusCode: 403 }, 403);
    if (serperMode === 'credits') return J({ message: 'Not enough credits', statusCode: 400 }, 400);
    const b = JSON.parse(init.body);
    if (u.pathname === '/search') return J({ searchParameters: b, organic: [{ title: '量子计算 - 维基百科', link: 'https://zh.wikipedia.org/wiki/x', snippet: '量子计算是……', position: 1 }, { title: '营销号', link: 'https://baijiahao.baidu.com/s?id=1', snippet: '震惊', position: 2 }, { title: '没有链接的', snippet: 'x' }], relatedSearches: [{ query: '量子计算机' }, { query: '量子比特' }] });
    if (u.pathname === '/images') return J({ images: [{ title: '图', imageUrl: 'https://img.example/a.jpg', imageWidth: 800, imageHeight: 600, thumbnailUrl: 'https://tbn.example/a', link: 'https://site.example/p', domain: 'site.example' }, { title: '坏图', imageUrl: 'javascript:alert(1)' }] });
    if (u.pathname === '/videos') return J({ videos: [{ title: '视频', link: 'https://www.youtube.com/watch?v=abc123DEF45', snippet: 's', imageUrl: 'https://i.ytimg.com/a.jpg', duration: '3:21', source: 'YouTube', channel: '频道', date: '2 天前' }] });
    return J({ news: [] });
  }
  if (u.host === 'zh.wikipedia.org') {
    wikiCalls++;
    if (!/Chatter/.test(H.get('user-agent') || '')) return J({ error: 'ua' }, 403);
    const q = u.searchParams.get('gsrsearch');
    if (q === '量子计算') return J({ query: { pages: [{ title: '量子計算', displaytitle: '量子计算', extract: '量子计算是一种遵循量子力学规律调控量子信息单元进行计算的新型计算模式。它和经典计算不同。第三句话。第四句话很长' + '很长'.repeat(200), fullurl: 'https://zh.wikipedia.org/wiki/%E9%87%8F', thumbnail: { source: 'https://upload.wikimedia.org/a.png' } }] } });
    return J({ query: { pages: [{ title: '完全无关', extract: '这一条和搜的词没关系，不应该显示成卡片。'.repeat(3) }] } });
  }
  siteCalls.push(u.href);
  if (u.host === 'news.example.com') return new Response(GBK_PAGE, { headers: { 'content-type': 'text/html' } });
  if (u.host === 'utf.example.com') return new Response(UTF_PAGE, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  if (u.host === 'hop.example.com') return new Response(null, { status: 302, headers: { location: '/landing' === u.pathname ? '' : 'https://utf.example.com/post' } });
  if (u.host === 'redir.example.com') return new Response(null, { status: 301, headers: { location: 'http://10.0.0.5/admin' } });
  if (u.host === 'files.example.com') return new Response('%PDF-1.4', { headers: { 'content-type': 'application/pdf' } });
  if (u.host === 'gone.example.com') return new Response('nope', { status: 404, headers: { 'content-type': 'text/html' } });
  if (u.host === 'big.example.com') {
    let sent = 0; const chunk = new TextEncoder().encode('<p>' + 'x'.repeat(65530) + '</p>');
    return new Response(new ReadableStream({ pull(c) { if (sent > 80) { c.close(); return; } sent++; c.enqueue(chunk); } }), { headers: { 'content-type': 'text/html' } });
  }
  if (u.host === 'home.example.com') return new Response('<html><body><a href="/a">首页链接</a><a href="/b">另一个</a></body></html>', { headers: { 'content-type': 'text/html' } });
  return realFetch(input, init);
};
const { handle, __test } = await import('../supabase/functions/chatter-search/index.ts');
let bad = 0; const ok = (c: unknown, msg: string) => { if (!c) bad++; console.log((c ? '✅ ' : '❌ ') + msg); };
const call = async (body: Any, tok: string | null = TOK) => {
  const r = await handle(new Request('https://proj.supabase.co/functions/v1/chatter-search', { method: 'POST', headers: { 'content-type': 'application/json', ...(tok ? { authorization: 'Bearer ' + tok } : {}) }, body: JSON.stringify(body) }));
  return { st: r.status, j: await r.json(), cors: r.headers.get('access-control-allow-origin') };
};
const settle = () => new Promise(r => setTimeout(r, 30));

let r = await call({ op: 'ping' }, null);
ok(r.j.ok && r.j.key === true && r.cors === '*', '检查服务器（不用登录）：装好了、密钥已填 → ' + JSON.stringify(r.j));
r = await call({ op: 'search', q: '天气' }, null);
ok(r.st === 401 && r.j.code === 'auth', '没登录：拒绝 → ' + r.j.msg);
r = await call({ op: 'search', q: '天气' }, 'sb_publishable_x');
ok(r.st === 401, '拿公开密钥冒充登录：拒绝');
r = await call({ op: 'search', q: '天气' }, 'xxx.yyy.zzz');
ok(r.st === 401, '假的登录凭证：拒绝');
const opt = await handle(new Request('https://x/', { method: 'OPTIONS' }));
ok(opt.status === 200 && opt.headers.get('access-control-allow-headers')?.includes('apikey'), '浏览器预检请求能通过');

r = await call({ op: 'search', q: '  量子计算 ', type: 'web' });
ok(r.j.ok && r.j.cached === false && r.j.items.length === 2, '搜网页：拿到 2 条（没有链接的那条丢掉）');
ok(r.j.wiki && r.j.wiki.t === '量子计算' && r.j.wiki.s.length <= 290 && r.j.wiki.u.includes('zh.m.wikipedia.org'), '百科卡片：标题对得上才显示、摘要截短、链到手机版 → ' + (r.j.wiki && r.j.wiki.s.slice(0, 30)));
ok(Array.isArray(r.j.rel) && r.j.rel[0] === '量子计算机', '相关搜索带回来了');
ok(r.j.left === 79, '今天还能搜 79 次');
await settle();
const s1 = serperCalls, w1 = wikiCalls;
r = await call({ op: 'search', q: '量子计算', type: 'web' });
ok(r.j.ok && r.j.cached === true && serperCalls === s1 && wikiCalls === w1 && r.j.wiki, '再搜一次同样的词：直接用缓存，不花额度、不算次数');
ok(counts.get(UID + '|s|false') === 1, '缓存命中没有加次数');
r = await call({ op: 'search', q: '量子计算', type: 'web', page: 2 });
ok(r.j.ok && r.j.cached === false && !r.j.wiki, '翻到第 2 页：重新搜（第 2 页不带百科卡片）');
r = await call({ op: 'search', q: '随便什么', type: 'web' });
ok(r.j.ok && !r.j.wiki, '维基第一条和搜的词对不上：不显示百科卡片');
r = await call({ op: 'search', q: '猫', type: 'images' });
ok(r.j.ok && r.j.items.length === 1 && r.j.items[0].th === 'https://tbn.example/a', '搜图片：坏地址被丢掉');
r = await call({ op: 'search', q: '猫', type: 'videos', tbs: 'qdr:w', gl: 'evil' });
ok(r.j.ok && r.j.items[0].dur === '3:21', '搜视频：时长等字段都在');
r = await call({ op: 'search', q: '   ' });
ok(!r.j.ok && r.j.code === 'bad', '空的搜索词：不去搜');

__test.reset(); CONF = { per_user_day: 6, read_per_user_day: 300, month_cap: 2400 };
const before = serperCalls;
for (const w of ['a1', 'a2']) await call({ op: 'search', q: w });
r = await call({ op: 'search', q: 'a3' });
ok(!r.j.ok && r.j.code === 'limit' && serperCalls === before + 1, '每人每天上限：到了就不再去搜 → ' + r.j.msg);
r = await call({ op: 'search', q: '量子计算' });
ok(r.j.ok && r.j.cached, '到上限后，搜过的词照样能看（走缓存）');

__test.reset(); CONF = { per_user_day: 80, read_per_user_day: 300, month_cap: counts.get('00000000-0000-0000-0000-000000000000|month|true') };
r = await call({ op: 'search', q: 'b1' });
ok(!r.j.ok && r.j.code === 'month', '每月总数到上限：所有人都停 → ' + r.j.msg);
__test.reset(); CONF = { per_user_day: 80, read_per_user_day: 300, month_cap: 2400 }; counts.clear();
serperMode = 'credits';
r = await call({ op: 'search', q: 'c1' });
ok(!r.j.ok && r.j.code === 'credits', 'Serper 额度用完：说清楚 → ' + r.j.msg);
serperMode = 'ok';
Deno.env.set('SERPER_API_KEY', '');
r = await call({ op: 'search', q: 'c2' });
ok(!r.j.ok && r.j.code === 'nokey', '服务器没填密钥：说清楚 → ' + r.j.msg);
Deno.env.set('SERPER_API_KEY', 'wrong');
r = await call({ op: 'search', q: 'c3' });
ok(!r.j.ok && r.j.code === 'nokey' && /密钥不对/.test(r.j.msg), '密钥填错：说清楚 → ' + r.j.msg);
Deno.env.set('SERPER_API_KEY', 'serper-test-key');
rpcMissing = true;
r = await call({ op: 'search', q: 'c4' });
ok(!r.j.ok && r.j.code === 'nosql', 'SQL 还没运行：说清楚 → ' + r.j.msg);
rpcMissing = false;
__test.reset(); CONF = { enabled: false };
r = await call({ op: 'search', q: 'c5' });
ok(!r.j.ok && r.j.code === 'off', '数据库里关掉搜索：立刻停用');
__test.reset(); CONF = { per_user_day: 80, read_per_user_day: 300, month_cap: 2400 };

r = await call({ op: 'read', url: 'https://news.example.com/a' });
ok(r.j.ok && r.j.html.includes('你好你好') && r.j.len > 300, '简洁阅读：GBK 编码的网页中文不乱码 → ' + (r.j.html || r.j.msg || '').slice(0, 40));
r = await call({ op: 'read', url: 'https://hop.example.com/x#frag' });
const h = r.j.html || '';
ok(r.j.ok && r.j.u === 'https://utf.example.com/post', '跳转后的网页也能取（记下最终地址）');
ok(!/script|onclick|onerror|style=|class=|javascript:|iframe|alert|推荐阅读|版权|导航/.test(h), '脚本、点击事件、样式、坏链接、内嵌框、侧栏、页脚全去掉');
ok(h.includes('<img src="https://utf.example.com/img/a.jpg">') && h.includes('href="https://utf.example.com/next"'), '懒加载的图换成真地址，相对地址补全');
ok(r.j.site === '测试站' && r.j.date === '2026-11-01' && r.j.title.includes('测试文章'), '网站名、日期、标题都在 → ' + [r.j.site, r.j.date, r.j.title].join(' / '));
ok(h.includes('<table>') && h.includes('<th>项目</th>') && h.includes('<td>表格</td>'), '表格保留');
const sc = siteCalls.length;
r = await call({ op: 'read', url: 'https://hop.example.com/x' });
ok(r.j.ok && r.j.cached && siteCalls.length === sc, '同一篇再打开：用缓存，不再去取');
for (const bad2 of ['http://127.0.0.1/', 'http://localhost:8080/', 'http://10.1.2.3/', 'http://192.168.1.1/', 'http://169.254.169.254/latest/meta-data/', 'http://[::1]/', 'http://kong:8000/', 'file:///etc/passwd', 'https://proj.supabase.co/rest/v1/profiles', 'http://0x7f.1/', 'https://a.b.internal/', 'https://user:pw@x.com/', 'https://x.com:22/']) {
  r = await call({ op: 'read', url: bad2 });
  ok(!r.j.ok && r.j.code === 'bad', '不能拿来访问内网/本机/自己的数据库：' + bad2);
}
r = await call({ op: 'read', url: 'https://redir.example.com/' });
ok(!r.j.ok && r.j.code === 'bad', '公开网站跳转到内网地址：拦住 → ' + r.j.msg);
r = await call({ op: 'read', url: 'https://files.example.com/a.pdf' });
ok(!r.j.ok && r.j.code === 'notHtml', 'PDF：提示用原网页打开 → ' + r.j.msg);
r = await call({ op: 'read', url: 'https://gone.example.com/' });
ok(!r.j.ok && r.j.code === 'fetch' && /不存在/.test(r.j.msg), '网页不存在：说清楚');
r = await call({ op: 'read', url: 'https://home.example.com/' });
ok(!r.j.ok && r.j.code === 'noArticle', '首页这类不是文章的：说清楚 → ' + r.j.msg);
const t0 = Date.now();
r = await call({ op: 'read', url: 'https://big.example.com/' });
ok(r.st === 200 && Date.now() - t0 < 8000, '超大网页（5 MB）：只读前 3 MB，不卡死 → ' + (r.j.ok ? '取到 ' + r.j.len + ' 字' : r.j.msg));
__test.reset(); CONF = { per_user_day: 80, read_per_user_day: 1, month_cap: 2400 }; counts.clear();
await call({ op: 'read', url: 'https://news.example.com/b' });
r = await call({ op: 'read', url: 'https://news.example.com/c' });
ok(!r.j.ok && r.j.code === 'limit', '简洁阅读每天上限 → ' + r.j.msg);
r = await call({ op: 'nope' });
ok(!r.j.ok && r.j.code === 'bad', '不认识的操作：拒绝');
console.log(bad ? `\n有 ${bad} 项没通过` : '\n全部通过');
Deno.exit(bad ? 1 : 0);
