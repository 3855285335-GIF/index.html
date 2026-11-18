// 搜索服务器函数的检查：在本机用 Deno 跑 supabase/functions/chatter-search/index.ts，
// 数据库、登录服务、Exa、Tavily、维基百科、互联网档案馆、论文库、GitHub、Hacker News、各种网站全部换成假的（不联网、不花额度）。
// 用法：cd tests && deno run -A --node-modules-dir=none fn-search-test.ts
Deno.env.set('CHATTER_TEST', '1');
Deno.env.set('SUPABASE_URL', 'https://proj.supabase.co');
Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'service.jwt.key');
Deno.env.set('SUPABASE_PUBLISHABLE_KEYS', JSON.stringify({ default: 'sb_publishable_test' }));
Deno.env.set('EXA_API_KEY', 'exa-test-key');
Deno.env.set('TAVILY_API_KEY', 'tvly-test-key');
// deno-lint-ignore no-explicit-any
type Any = any;
const UID = '11111111-1111-4111-8111-111111111111', TOK = 'aaa.bbb.ccc', ALL = '00000000-0000-0000-0000-000000000000';
let CONF: Any = {}, DBKEYS: Any[] = [];
const cache = new Map<string, Any>(), counts = new Map<string, number>();
let rpcMissing = false, siteCalls: string[] = [], exaBodies: Any[] = [], tavBodies: Any[] = [];
const calls: Record<string, number> = {};
let exaMode = 'ok', tavMode = 'ok', deepDown = '';
const hitc = (k: string) => { calls[k] = (calls[k] || 0) + 1; };
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
const OLD_PAGE = `<html><head><title>旧版文章</title></head><body><article><h1>旧版文章</h1><p>${'这是 2019 年的旧版本内容，现在网站上已经删掉了。'.repeat(10)}</p><p><img src="/pic/old.jpg"> <a href="/about">关于</a></p><p>${LONG}</p></article></body></html>`;
const realFetch = globalThis.fetch;
const J = (o: Any, st = 200, h: Record<string, string> = {}) => new Response(JSON.stringify(o), { status: st, headers: { 'content-type': 'application/json', ...h } });
globalThis.fetch = async (input: Any, init: Any = {}) => {
  const u = new URL(typeof input === 'string' ? input : input.url), m = (init.method || 'GET').toUpperCase();
  const H = new Headers(init.headers || {});
  if (u.host === 'proj.supabase.co') {
    if (u.pathname === '/auth/v1/user' && H.get('apikey') !== 'sb_publishable_test') return J({ msg: 'auth 要用公开密钥' }, 401);
    if (u.pathname !== '/auth/v1/user' && H.get('apikey') !== 'service.jwt.key') return J({ msg: 'no key' }, 401);
    if (u.pathname === '/auth/v1/user') return H.get('authorization') === 'Bearer ' + TOK ? J({ id: UID }) : J({ msg: 'bad jwt' }, 403);
    if (H.get('authorization') !== 'Bearer service.jwt.key') return J({ msg: 'no auth' }, 401);
    if (u.pathname === '/rest/v1/app_config') return J([{ value: CONF }]);
    if (u.pathname === '/rest/v1/search_keys') return J(DBKEYS);
    if (u.pathname === '/rest/v1/search_cache') {
      if (m === 'GET') {
        const f = u.searchParams.get('k') || '';
        const ks = f.startsWith('in.(') ? f.slice(4, -1).split(',') : [f.replace(/^eq\./, '')];
        return J(ks.filter(k => cache.has(k)).map(k => ({ k, ...cache.get(k) })));
      }
      if (m === 'POST') { const b = JSON.parse(init.body); cache.set(b.k, { v: b.v, at: b.at }); return new Response(null, { status: 201 }); }
      if (m === 'DELETE') return new Response(null, { status: 204 });
    }
    if (u.pathname === '/rest/v1/search_usage') {
      if (m === 'DELETE') return new Response(null, { status: 204 });
      const out: Any[] = []; counts.forEach((n, k) => { const [uid, kind, month] = k.split('|'); if (uid === ALL && month === 'true') out.push({ kind, n }); });
      return J(out);
    }
    if (u.pathname === '/rest/v1/rpc/search_bump') {
      if (rpcMissing) return J({ code: 'PGRST202', message: 'Could not find the function' }, 404);
      const b = JSON.parse(init.body), k = b.p_uid + '|' + b.p_kind + '|' + b.p_month, n = counts.get(k) || 0;
      if (n >= b.p_limit) return J(-1);
      counts.set(k, n + 1); return J(n + 1);
    }
    return J({ msg: 'unknown ' + u.pathname }, 404);
  }
  if (u.host === 'api.exa.ai') {
    hitc('exa'); const b = JSON.parse(init.body); exaBodies.push(b);
    if (H.get('x-api-key') !== 'exa-test-key') return J({ error: 'Invalid API key' }, 401);
    if (exaMode === 'empty') return J({ requestId: 'r', error: 'Out of credits', tag: 'NO_MORE_CREDITS' }, 402);
    if (exaMode === 'down') return J({ error: 'boom' }, 503);
    if (exaMode === 'nolite' && b.contents) return J({ error: 'contents not supported' }, 400);
    if (b.includeDomains) return J({ results: [{ title: '视频一', url: 'https://www.youtube.com/watch?v=abcdefghijk', image: 'https://i.ytimg.com/a.jpg', author: '频道', publishedDate: '2026-10-01T00:00:00Z' }] });
    return J({ results: [{ title: '量子计算 - 维基百科', url: 'https://zh.wikipedia.org/wiki/x', highlights: ['量子计算是……', '第二句'], publishedDate: '2025-01-02T00:00:00.000Z', image: 'https://img.example/q.jpg' }, { title: '营销号', url: 'https://baijiahao.baidu.com/s?id=1', highlights: ['震惊'] }, { title: '没有链接的' }] });
  }
  if (u.host === 'api.tavily.com') {
    hitc('tavily'); const b = JSON.parse(init.body); tavBodies.push(b);
    if (H.get('authorization') !== 'Bearer tvly-test-key') return J({ detail: { error: 'Unauthorized' } }, 401);
    if (tavMode === 'empty') return J({ detail: { error: "This request exceeds your plan's set usage limit." } }, 432);
    if (b.include_images) return J({ results: [{ title: '极光页', url: 'https://travel.example.org/a', content: 'x', images: [{ url: 'https://img.example/1.jpg', description: '极光一' }, { url: 'https://img.example/2.jpg', description: '极光二' }] }], images: [{ url: 'https://img.example/2.jpg', description: '重复' }, { url: 'https://img.example/3.jpg', title: '想看极光来这里', description: 'Green aurora over a lake.' }] });
    return J({ results: [{ title: 'Tavily 的结果', url: 'https://t.example.com/1', content: 'Title: 页面标题\n### 入门视频 (从这里开始！)\n\n1. **第一条** [链接](https://x.example/) 来自 Tavily [...] 后面', score: 0.9, published_date: '2026-11-10' }] });
  }
  if (u.host === 'zh.wikipedia.org' || u.host === 'en.wikipedia.org') {
    hitc('wiki');
    if (!/Chatter/.test(H.get('user-agent') || '')) return J({ error: 'ua' }, 403);
    if (deepDown.includes('wiki')) return J({}, 503);
    if (u.searchParams.get('gsrlimit') === '6') { ok(u.searchParams.get('prop') === 'extracts|info' && u.searchParams.get('variant') === 'zh-cn', '深挖·维基百科：用“搜索 + 简体摘要”的取法'); return J({ query: { pages: [{ title: '量子比特', index: 2, extract: '量子比特是……' }, { title: '量子計算', displaytitle: '量子计算', index: 1, extract: '量子计算是一种……', touched: '2026-09-01T00:00:00Z' }] } }); }
    const q = u.searchParams.get('gsrsearch');
    if (q === '量子计算') return J({ query: { pages: [{ title: '量子計算', displaytitle: '量子计算', extract: '量子计算是一种遵循量子力学规律调控量子信息单元进行计算的新型计算模式。它和经典计算不同。第三句话。第四句话很长' + '很长'.repeat(200), fullurl: 'https://zh.wikipedia.org/wiki/%E9%87%8F', thumbnail: { source: 'https://upload.wikimedia.org/a.png' } }] } });
    return J({ query: { pages: [{ title: '完全无关', extract: '这一条和搜的词没关系，不应该显示成卡片。'.repeat(3) }] } });
  }
  if (u.host === 'commons.wikimedia.org') { hitc('commons'); return J({ query: { pages: [{ title: 'File:Aurora borealis.jpg', imageinfo: [{ url: 'https://upload.wikimedia.org/a.jpg', thumburl: 'https://upload.wikimedia.org/thumb/a.jpg', width: 4000, height: 3000, mime: 'image/jpeg', descriptionurl: 'https://commons.wikimedia.org/wiki/File:A.jpg' }] }, { title: 'File:Doc.pdf', imageinfo: [{ url: 'https://upload.wikimedia.org/d.pdf', mime: 'application/pdf' }] }] } }); }
  if (u.host === 'archive.org' && u.pathname === '/advancedsearch.php') {
    hitc('archive'); if (deepDown.includes('archive')) return J({}, 503);
    return J({ response: { docs: [{ identifier: 'quantum-book', title: '量子计算导论', description: '<p>一本书</p>', mediatype: 'texts', year: '2001', creator: ['某作者'] }] } });
  }
  if (u.host === 'archive.org' && u.pathname === '/wayback/available') {
    hitc('avail');
    const url = u.searchParams.get('url') || '';
    if (url.includes('never')) return J({ archived_snapshots: {} });
    return J({ archived_snapshots: { closest: { available: true, url: 'http://web.archive.org/web/20190302000000/' + url, timestamp: '20190302000000', status: '200' } } });
  }
  if (u.host === 'web.archive.org' && u.pathname.startsWith('/cdx/')) {
    hitc('cdx');
    return J([['timestamp', 'statuscode'], ['20150101000000', '200'], ['20190302000000', '200'], ['20240501000000', '200']]);
  }
  if (u.host === 'web.archive.org') {
    hitc('wb'); siteCalls.push(u.href);
    const m = /^\/web\/(\d+)id_\/(.*)$/.exec(u.pathname + u.search);
    if (m && m[1] !== '20190302000000') return new Response(null, { status: 302, headers: { location: '/web/20190302000000id_/' + m[2] } });
    return new Response(OLD_PAGE, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  }
  if (u.host === 'api.openalex.org') { hitc('openalex'); if (deepDown.includes('openalex')) return J({}, 500); return J({ results: [{ id: 'https://openalex.org/W1', display_name: '量子计算综述', publication_year: 2020, doi: 'https://doi.org/10.1/x', open_access: { oa_url: 'https://arxiv.org/pdf/0000.pdf' }, authorships: [{ author: { display_name: '张三' } }, { author: { display_name: '李四' } }], cited_by_count: 12 }] }); }
  if (u.host === 'api.github.com') { hitc('github'); if (!H.get('user-agent')) return J({ message: 'UA required' }, 403); return J({ items: [{ full_name: 'qiskit/qiskit', html_url: 'https://github.com/qiskit/qiskit', description: '开源工具包', stargazers_count: 5000, language: 'Python', pushed_at: '2026-11-01T00:00:00Z' }] }); }
  if (u.host === 'hn.algolia.com') { hitc('hn'); return J({ hits: [{ objectID: '123', title: 'Quantum computing explained', url: 'https://blog.example.com/q', points: 321, num_comments: 45, created_at: '2026-01-01T00:00:00Z' }, { objectID: '124', title: 'Ask HN: quantum?', url: null, points: 3, num_comments: 2 }] }); }
  siteCalls.push(u.href);
  if (u.host === 'news.example.com') return new Response(GBK_PAGE, { headers: { 'content-type': 'text/html' } });
  if (u.host === 'utf.example.com') return new Response(UTF_PAGE, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  if (u.host === 'hop.example.com') return new Response(null, { status: 302, headers: { location: 'https://utf.example.com/post' } });
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
const reset = (c: Any = {}) => { __test.reset(); CONF = c; };

let r = await call({ op: 'ping' }, null);
ok(r.j.ok && r.j.keys.exa && r.j.keys.tavily && r.cors === '*', '检查服务器（不用登录）：两家密钥都填了 → ' + JSON.stringify(r.j));
Deno.env.set('TAVILY_API_KEY', ''); DBKEYS = [{ name: 'TAVILY_API_KEY', value: ' tvly-test-key ' }]; __test.reset();
r = await call({ op: 'ping' }, null);
ok(r.j.keys.tavily === true, '环境变量里没有、数据库 search_keys 表里有：照样读得到');
r = await call({ op: 'search', q: '数据库里的密钥', type: 'web', src: 'tavily' });
ok(r.j.ok && r.j.src === 'tavily', '用数据库里的 Tavily 密钥能搜（前后空格去掉）');
Deno.env.set('TAVILY_API_KEY', 'tvly-test-key'); DBKEYS = []; __test.reset(); counts.clear(); cache.clear();
r = await call({ op: 'search', q: '天气' }, null);
ok(r.st === 401 && r.j.code === 'auth', '没登录：拒绝 → ' + r.j.msg);
r = await call({ op: 'search', q: '天气' }, 'sb_publishable_x');
ok(r.st === 401, '拿公开密钥冒充登录：拒绝');
r = await call({ op: 'search', q: '天气' }, 'xxx.yyy.zzz');
ok(r.st === 401, '假的登录凭证：拒绝');
const opt = await handle(new Request('https://x/', { method: 'OPTIONS' }));
ok(opt.status === 200 && opt.headers.get('access-control-allow-headers')?.includes('apikey'), '浏览器预检请求能通过');

// ---- 网页：默认 Exa ----
r = await call({ op: 'search', q: '  量子计算 ', type: 'web', tbs: 'week' });
ok(r.j.ok && r.j.src === 'exa' && r.j.items.length === 2, '搜网页：默认用 Exa，拿到 2 条（没有链接的丢掉）');
const eb = exaBodies[exaBodies.length - 1];
ok(eb.type === 'lite' && eb.numResults === 10 && eb.contents && eb.startPublishedDate && Date.now() - Date.parse(eb.startPublishedDate) > 6 * 86400000, 'Exa 请求：简版、10 条、带摘要、“一周内”换成起始日期');
ok(r.j.items[0].s === '量子计算是…… … 第二句' && r.j.items[0].d === '2025-01-02', '摘要和日期整理好了 → ' + r.j.items[0].s);
ok(r.j.wiki && r.j.wiki.t === '量子计算' && r.j.wiki.s.length <= 290 && r.j.wiki.u.includes('zh.m.wikipedia.org'), '百科卡片：标题对得上才显示、摘要截短、链到手机版');
ok(r.j.used === 1 && r.j.left === undefined, '记下 Exa 本月用了 1 次；默认不限次数，所以不报还剩几次');
await settle();
const e1 = calls.exa;
r = await call({ op: 'search', q: '量子计算', type: 'web', tbs: 'week' });
ok(r.j.ok && r.j.cached && calls.exa === e1, '再搜一次同样的词：直接用缓存，不花额度');
r = await call({ op: 'search', q: '量子计算', type: 'web', src: 'tavily' });
ok(r.j.ok && r.j.src === 'tavily' && r.j.items[0].t === 'Tavily 的结果', '点“换 Tavily”：用 Tavily 重搜');
ok(r.j.items[0].s === '入门视频 (从这里开始！) 1. 第一条 链接 来自 Tavily … 后面', 'Tavily 的摘要去掉排版符号 → ' + r.j.items[0].s);
const tb = tavBodies[tavBodies.length - 1];
ok(tb.language === 'zh-cn' && tb.search_depth === 'basic' && tb.topic === 'general', 'Tavily 请求：中文优先、基础档（1 次额度）');
r = await call({ op: 'search', q: '别的词', type: 'web', pref: 'tavily' });
ok(r.j.src === 'tavily', '规则里选了先用 Tavily：先用 Tavily');
r = await call({ op: 'search', q: '随便什么', type: 'web' });
ok(r.j.ok && !r.j.wiki, '维基第一条和搜的词对不上：不显示百科卡片');
r = await call({ op: 'search', q: 'site:GitHub.com/ 量子 模拟器', type: 'web' });
const sb2 = exaBodies[exaBodies.length - 1];
ok(r.j.ok && sb2.query === '量子 模拟器' && sb2.includeDomains.join() === 'github.com' && !r.j.wiki, '“site:网址”：拆成 Exa 的“只搜这个网站”参数，搜索词里去掉');
r = await call({ op: 'search', q: 'site:github.com 量子', type: 'web', src: 'tavily' });
ok(r.j.ok && tavBodies[tavBodies.length - 1].include_domains.join() === 'github.com' && tavBodies[tavBodies.length - 1].query === '量子', '“site:网址”：Tavily 也一样');
r = await call({ op: 'search', q: 'site:github.com', type: 'web' });
ok(!r.j.ok && r.j.code === 'bad', '只写了“site:”没写要搜的词：提示');
exaMode = 'nolite';
r = await call({ op: 'search', q: '简版不支持摘要', type: 'web' });
ok(r.j.ok && r.j.src === 'exa' && !exaBodies[exaBodies.length - 1].contents, 'Exa 简版万一不支持摘要：自动去掉摘要再搜一次');
exaMode = 'ok';

// ---- 新闻、视频、图片 ----
r = await call({ op: 'search', q: '新闻词', type: 'news' });
ok(r.j.ok && exaBodies[exaBodies.length - 1].category === 'news' && r.j.items[0].img, '新闻：Exa 按新闻类搜，带配图');
r = await call({ op: 'search', q: '量子 视频', type: 'videos' });
ok(r.j.ok && exaBodies[exaBodies.length - 1].includeDomains.includes('bilibili.com') && r.j.items[0].img && r.j.items[0].ch === '频道', '视频：只在 YouTube、B 站、Vimeo 里搜，带封面');
r = await call({ op: 'search', q: '极光', type: 'images' });
ok(r.j.ok && r.j.src === 'tavily' && tavBodies[tavBodies.length - 1].include_images, '图片：先用 Tavily（它能从网页里找图）');
ok(r.j.items.find((x: Any) => x.img === 'https://img.example/3.jpg').t === '想看极光来这里', '图片文字优先用中文网页标题，不用英文描述');
ok(r.j.items.length === 4 && r.j.items[0].u === 'https://travel.example.org/a' && r.j.items.some((x: Any) => x.src === '维基共享资源' && x.w === 4000), '图片：去重、带来源网页，再加上维基共享资源的图（PDF 不要） → ' + r.j.items.length + ' 张');

// ---- 用完自动换 ----
reset(); counts.clear(); exaMode = 'empty';
const t1 = calls.tavily || 0;
r = await call({ op: 'search', q: 'Exa 用完了', type: 'web' });
ok(r.j.ok && r.j.src === 'tavily' && calls.tavily === t1 + 1, 'Exa 这个月用完：自动换 Tavily');
await settle();
const e2 = calls.exa;
r = await call({ op: 'search', q: 'Exa 用完了 2', type: 'web' });
ok(r.j.ok && r.j.src === 'tavily' && calls.exa === e2, '刚发现 Exa 用完：6 小时内不再去试（省时间）');
ok(counts.get(UID + '|s|false') === 2, '换来换去只算一次搜索次数');
tavMode = 'empty';
r = await call({ op: 'search', q: '都用完了', type: 'web' });
ok(!r.j.ok && r.j.code === 'empty' && /Exa、Tavily/.test(r.j.msg) && /下个月 1 号/.test(r.j.msg) && /深挖/.test(r.j.msg), '两家都用完：说清楚什么时候恢复、深挖还能用 → ' + r.j.msg);
r = await call({ op: 'search', q: '量子计算', type: 'web', tbs: 'week' });
ok(r.j.ok && r.j.cached, '都用完了以后，搜过的词照样能看（走缓存）');
r = await call({ op: 'search', q: '都用完的图', type: 'images' });
ok(r.j.ok && r.j.src === 'commons' && r.j.partial, '都用完了搜图片：还能看维基共享资源的图');
cache.clear(); exaMode = 'down'; tavMode = 'ok';
r = await call({ op: 'search', q: 'Exa 坏了', type: 'web' });
ok(r.j.ok && r.j.src === 'tavily' && !cache.has('x-exa'), 'Exa 临时出错：换 Tavily，但不记成“用完了”');
exaMode = 'ok';
Deno.env.set('EXA_API_KEY', '');
r = await call({ op: 'search', q: '没填 Exa', type: 'web' });
ok(r.j.ok && r.j.src === 'tavily', '只填了 Tavily 的密钥：照样能搜');
Deno.env.set('TAVILY_API_KEY', '');
r = await call({ op: 'search', q: '都没填', type: 'web' });
ok(!r.j.ok && r.j.code === 'nokey' && /Exa 或 Tavily/.test(r.j.msg), '两家密钥都没填：说清楚 → ' + r.j.msg);
Deno.env.set('EXA_API_KEY', 'wrong'); Deno.env.set('TAVILY_API_KEY', 'tvly-test-key');
r = await call({ op: 'search', q: '密钥填错', type: 'web', src: 'exa' });
ok(!r.j.ok && r.j.code === 'nokey' && /Exa 的密钥不对/.test(r.j.msg), '指定用 Exa 但密钥填错：说清楚 → ' + r.j.msg);
Deno.env.set('EXA_API_KEY', 'exa-test-key');
await call({ op: 'search', q: '算一次 Exa', type: 'web' });
r = await call({ op: 'usage' });
ok(r.j.ok && r.j.used.exa >= 1 && r.j.used.tavily >= 1 && r.j.free.exa === 2500 && r.j.free.tavily === 1000, '查本月用量 → ' + JSON.stringify(r.j.used));

// ---- 上限 ----
reset({ per_user_day: 1000000000 }); counts.clear(); cache.clear();
r = await call({ op: 'search', q: '不限次数' });
ok(r.j.ok && r.j.left === undefined, '不限次数时：不报“今天还剩几次”');
reset({ per_user_day: 2 }); counts.clear(); cache.clear();
await call({ op: 'search', q: 'a1' }); await call({ op: 'search', q: 'a2' });
const e3 = calls.exa;
r = await call({ op: 'search', q: 'a3' });
ok(!r.j.ok && r.j.code === 'limit' && calls.exa === e3, '每人每天上限：到了就不再去搜 → ' + r.j.msg);
rpcMissing = true;
r = await call({ op: 'search', q: 'c4' });
ok(!r.j.ok && r.j.code === 'nosql', 'SQL 还没运行：说清楚 → ' + r.j.msg);
rpcMissing = false;
reset({ enabled: false });
r = await call({ op: 'search', q: 'c5' });
ok(!r.j.ok && r.j.code === 'off', '数据库里关掉搜索：立刻停用');
reset(); counts.clear(); cache.clear();
r = await call({ op: 'search', q: '   ' });
ok(!r.j.ok && r.j.code === 'bad', '空的搜索词：不去搜');

// ---- 深挖 ----
const ex0 = calls.exa || 0, tv0 = calls.tavily || 0;
r = await call({ op: 'search', q: '量子计算', type: 'deep' });
const g = (k: string) => (r.j.groups || []).find((x: Any) => x.k === k);
ok(r.j.ok && r.j.groups.length === 5 && calls.exa === ex0 && calls.tavily === tv0, '深挖：5 个数据库都有结果，而且不花 Exa、Tavily 的次数');
ok(g('wiki').items[0].t === '量子计算' && g('wiki').items[0].s === '量子计算是一种……' && g('wiki').items[0].f === '更新于 2026-09-01' && g('wiki').items[1].t === '量子比特' && g('wiki').items[0].u.includes('zh.m.wikipedia.org'), '深挖·维基百科：按搜索顺序排、用简体标题和摘要、链到手机版');
ok(g('archive').items[0].f === '书 / 文档 · 2001 · 某作者' && g('archive').items[0].ext && g('archive').items[0].img, '深挖·互联网档案馆：类型、年份、作者、封面');
ok(g('papers').items[0].u === 'https://arxiv.org/pdf/0000.pdf' && g('papers').items[0].ext && /被引用 12 次/.test(g('papers').items[0].f), '深挖·论文：优先给免费全文（PDF 用浏览器打开）');
ok(g('github').items[0].f.startsWith('★ 5000 · Python'), '深挖·GitHub：星数、语言、更新时间');
ok(g('hn').items[1].u === 'https://news.ycombinator.com/item?id=124' && g('hn').items[0].c, '深挖·Hacker News：没有原文链接的直接链到讨论');
ok(counts.get(UID + '|d|false') === 1 && !counts.get(UID + '|s|false'), '深挖单独计数，不占搜索次数');
deepDown = 'wiki,archive,openalex';
r = await call({ op: 'search', q: '深挖有几家连不上', type: 'deep' });
ok(r.j.ok && r.j.groups.length === 2 && r.j.down.length === 3, '深挖有几家连不上：其余照常显示，并说明哪几家没连上 → ' + r.j.down.join('、'));
deepDown = '';

// ---- 简洁阅读 ----
r = await call({ op: 'read', url: 'https://news.example.com/a' });
ok(r.j.ok && r.j.html.includes('你好你好') && r.j.len > 300, '简洁阅读：GBK 编码的网页中文不乱码');
r = await call({ op: 'read', url: 'https://hop.example.com/x#frag' });
const h = r.j.html || '';
ok(r.j.ok && r.j.u === 'https://utf.example.com/post', '跳转后的网页也能取（记下最终地址）');
ok(!/script|onclick|onerror|style=|class=|javascript:|iframe|alert|推荐阅读|版权|导航/.test(h), '脚本、点击事件、样式、坏链接、内嵌框、侧栏、页脚全去掉');
ok(h.includes('<img src="https://utf.example.com/img/a.jpg">') && h.includes('href="https://utf.example.com/next"'), '懒加载的图换成真地址，相对地址补全');
ok(r.j.site === '测试站' && r.j.date === '2026-11-01' && h.includes('<th>项目</th>'), '网站名、日期、表格都在');
const sc = siteCalls.length;
r = await call({ op: 'read', url: 'https://hop.example.com/x' });
ok(r.j.ok && r.j.cached && siteCalls.length === sc, '同一篇再打开：用缓存，不再去取');
for (const b2 of ['http://127.0.0.1/', 'http://localhost:8080/', 'http://10.1.2.3/', 'http://192.168.1.1/', 'http://169.254.169.254/latest/meta-data/', 'http://[::1]/', 'http://kong:8000/', 'file:///etc/passwd', 'https://proj.supabase.co/rest/v1/profiles', 'http://0x7f.1/', 'https://a.b.internal/', 'https://user:pw@x.com/', 'https://x.com:22/']) {
  r = await call({ op: 'read', url: b2 });
  ok(!r.j.ok && r.j.code === 'bad', '不能拿来访问内网/本机/自己的数据库：' + b2);
}
r = await call({ op: 'read', url: 'https://redir.example.com/' });
ok(!r.j.ok && r.j.code === 'bad', '公开网站跳转到内网地址：拦住');
r = await call({ op: 'read', url: 'https://files.example.com/a.pdf' });
ok(!r.j.ok && r.j.code === 'notHtml', 'PDF：提示用原网页打开');
r = await call({ op: 'read', url: 'https://gone.example.com/' });
ok(!r.j.ok && r.j.code === 'fetch' && /不存在/.test(r.j.msg), '网页不存在：说清楚');
r = await call({ op: 'read', url: 'https://home.example.com/' });
ok(!r.j.ok && r.j.code === 'noArticle', '首页这类不是文章的：说清楚');
const t0 = Date.now();
r = await call({ op: 'read', url: 'https://big.example.com/' });
ok(r.st === 200 && Date.now() - t0 < 8000, '超大网页（5 MB）：只读前 3 MB，不卡死');

// ---- 存档、历史版本 ----
r = await call({ op: 'read', url: 'https://gone.example.com/post/1', at: 'latest' });
const ah = r.j.html || '';
ok(r.j.ok && r.j.arch === '20190302000000' && /2019 年的旧版本/.test(ah), '看存档：网页没了也能看到互联网档案馆存的版本');
ok(ah.includes('src="https://web.archive.org/web/20190302000000im_/https://gone.example.com/pic/old.jpg"') && ah.includes('href="https://gone.example.com/about"'), '存档里的图片从档案馆取、链接按原网址补全');
ok(r.j.u === 'https://gone.example.com/post/1', '存档文章记的还是原网址');
r = await call({ op: 'read', url: 'https://gone.example.com/post/1', at: '2019' });
ok(r.j.ok && r.j.arch === '20190302000000', '指定年份：取最接近的一版，并说出实际是哪一天的');
r = await call({ op: 'read', url: 'https://never.example.com/x', at: 'latest' });
ok(!r.j.ok && r.j.code === 'noArchive', '档案馆没存过：说清楚 → ' + r.j.msg);
r = await call({ op: 'read', url: 'https://gone.example.com/post/1', at: 'abc' });
ok(!r.j.ok && r.j.code === 'bad', '存档时间乱填：拒绝');
r = await call({ op: 'versions', url: 'https://gone.example.com/post/1' });
ok(r.j.ok && r.j.list.join(',') === '20240501000000,20190302000000,20150101000000', '历史版本：最新的在前 → ' + (r.j.list || []).length + ' 个');
reset({ read_per_user_day: 1 }); counts.clear(); cache.clear();
await call({ op: 'read', url: 'https://news.example.com/b' });
r = await call({ op: 'read', url: 'https://news.example.com/c' });
ok(!r.j.ok && r.j.code === 'limit', '简洁阅读每天上限');
r = await call({ op: 'nope' });
ok(!r.j.ok && r.j.code === 'bad', '不认识的操作：拒绝');
console.log(bad ? `\n有 ${bad} 项没通过` : '\n全部通过');
Deno.exit(bad ? 1 : 0);
