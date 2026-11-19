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
const UID2 = '22222222-2222-4222-8222-222222222222', TOK2 = 'ddd.eee.fff';
let CONF: Any = {}, DBKEYS: Any[] = [], sessionAlive = true;
const cache = new Map<string, Any>(), counts = new Map<string, number>();
let rpcMissing = false, siteCalls: string[] = [], exaBodies: Any[] = [], tavBodies: Any[] = [];
const calls: Record<string, number> = {};
let exaMode = 'ok', tavMode = 'ok', deepDown = '', glmMode = 'ok', flakyOnce = false;
const trBodies: Any[] = [];
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
    if (u.pathname === '/auth/v1/user' || u.pathname === '/rest/v1/rpc/session_alive') {
      if (H.get('apikey') !== 'sb_publishable_test') return J({ msg: 'auth 要用公开密钥' }, 401);
      const token = H.get('authorization');
      const id = token === 'Bearer ' + TOK ? UID : token === 'Bearer ' + TOK2 ? UID2 : null;
      if (!id) return J({ msg: 'bad jwt' }, 403);
      return u.pathname === '/auth/v1/user' ? J({ id }) : J(sessionAlive);
    }
    if (H.get('apikey') !== 'service.jwt.key') return J({ msg: 'no key' }, 401);
    if (H.get('authorization') !== 'Bearer service.jwt.key') return J({ msg: 'no auth' }, 401);
    if (u.pathname === '/rest/v1/app_config') return J([{ value: CONF }]);
    if (u.pathname === '/rest/v1/search_keys') return J(DBKEYS);
    if (u.pathname === '/rest/v1/search_cache') {
      if (m === 'GET') {
        const f = u.searchParams.get('k') || '';
        const ks = f.startsWith('in.(') ? f.slice(4, -1).split(',') : [f.replace(/^eq\./, '')];
        return J(ks.filter(k => cache.has(k)).map(k => ({ k, ...cache.get(k) })));
      }
      if (m === 'POST') { const b = JSON.parse(init.body); (Array.isArray(b) ? b : [b]).forEach((x: Any) => cache.set(x.k, { v: x.v, at: x.at })); return new Response(null, { status: 201 }); }
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
    return J({ results: [{ title: '量子计算 - 维基百科', url: 'https://zh.wikipedia.org/wiki/x', highlights: ['量子计算 - 维基百科\n\n## 量子计算 - 维基百科 2025-01-02 来源：维基\\_百科\n\n量子计算是……', '第二句'], publishedDate: '2025-01-02T00:00:00.000Z', image: 'https://img.example/q.jpg' }, { title: '营销号', url: 'https://baijiahao.baidu.com/s?id=1', highlights: ['震惊'] }, { title: '没有链接的' }] });
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
    if (u.pathname.includes('busyarch.example.com')) return new Response('Too Many Requests', { status: 429 });
    if (u.pathname.includes('flaky.example.com') && !flakyOnce) { flakyOnce = true; return new Response('Too Many Requests', { status: 429 }); }
    const m = /^\/web\/(\d+)id_\/(.*)$/.exec(u.pathname + u.search);
    if (m && m[1] !== '20190302000000') return new Response(null, { status: 302, headers: { location: '/web/20190302000000id_/' + m[2] } });
    return new Response(OLD_PAGE, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  }
  if (u.host === 'api.openalex.org') { hitc('openalex'); if (deepDown.includes('openalex')) return J({}, 500); return J({ results: [{ id: 'https://openalex.org/W1', display_name: '量子计算综述', publication_year: 2020, doi: 'https://doi.org/10.1/x', open_access: { oa_url: 'https://arxiv.org/pdf/0000.pdf' }, authorships: [{ author: { display_name: '张三' } }, { author: { display_name: '李四' } }], cited_by_count: 12 }] }); }
  if (u.host === 'api.github.com') { hitc('github'); if (!H.get('user-agent')) return J({ message: 'UA required' }, 403); return J({ items: [{ full_name: 'qiskit/qiskit', html_url: 'https://github.com/qiskit/qiskit', description: '开源工具包', stargazers_count: 5000, language: 'Python', pushed_at: '2026-11-01T00:00:00Z' }] }); }
  if (u.host === 'hn.algolia.com') { hitc('hn'); return J({ hits: [{ objectID: '123', title: 'Quantum computing explained', url: 'https://blog.example.com/q', points: 321, num_comments: 45, created_at: '2026-01-01T00:00:00Z' }, { objectID: '124', title: 'Ask HN: quantum?', url: null, points: 3, num_comments: 2 }] }); }
  if (u.host === 'open.bigmodel.cn' || u.host === 'api.groq.com') {   // 假的翻译服务：每段前面加“智:”或“G:”，含“敏感”的整次请求被拒
    const glm = u.host === 'open.bigmodel.cn'; hitc(glm ? 'glm' : 'groq');
    const b = JSON.parse(init.body); trBodies.push({ host: u.host, b });
    if (H.get('authorization') !== 'Bearer ' + (glm ? 'zp-test' : 'gq-test')) return J({ error: { code: '1000', message: '令牌已过期或验证不正确' } }, 401);
    const segs: string[] = []; const user = b.messages[1].content; const re = /⟦(\d+)⟧\n([\s\S]*?)(?=\n⟦\d+⟧\n|$)/g; let mm;
    while ((mm = re.exec(user))) segs.push(mm[2]);
    if (glm && glmMode === 'busyOnce') { glmMode = 'ok'; return J({ error: { code: '1302', message: '您的账户已达到速率限制' } }, 429); }
    if (glm && b.model === 'busy-model') return J({ error: { code: '1305', message: '该模型当前访问量过大，请您稍后再试' } }, 429);
    if (glm && b.model === 'gone-model') return J({ error: { code: '1211', message: '模型不存在，请检查模型代码。' } }, 400);
    if (glm && segs.some(s => s.includes('敏感'))) return J({ error: { code: '1301', message: '系统检测到输入或生成内容可能包含不安全或敏感内容' } }, 400);
    const pre = glm ? '智:' : 'G:';
    const body = (glm && glmMode === 'nomarkers' && segs.length > 1) ? segs.map(s => pre + s).join('\n') : segs.map((s, i) => '⟦' + (i + 1) + '⟧\n' + pre + s).join('\n');
    return J({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: segs.length === 1 && glmMode === 'nomarkers' ? pre + segs[0] : body } }] });
  }
  siteCalls.push(u.href);
  if (u.hostname.endsWith('.invalid')) throw new TypeError('error sending request for url (' + u.href + '): client error (Connect): dns error: failed to lookup address information: Name or service not known');
  if (u.host === 'nohost.example.com') throw new TypeError('error sending request for url (https://nohost.example.com/): client error (Connect): dns error: failed to lookup address information: Name or service not known');
  if (u.host === 'login.example.com') return new Response('forbidden', { status: 403, headers: { 'content-type': 'text/html' } });
  if (u.host === 'busy.example.com') return new Response('slow down', { status: 429, headers: { 'content-type': 'text/html' } });
  if (u.host === 'down.example.com') return new Response('oops', { status: 503, headers: { 'content-type': 'text/html' } });
  if (u.host === 'parked.example.com') return new Response(null, { status: 302, headers: { location: 'https://gotowww.parking.example/6d/?parked.example.com' } });
  if (u.host === 'gotowww.parking.example') return new Response('<html><head><title>welcome</title></head><body><div>welcome</div><a href="/x">Click here now</a></body></html>', { headers: { 'content-type': 'text/html' } });
  if (u.host === 'portal.example.com') return new Response('<html lang="en"><head><title>Portal Home</title><meta name="description" content="A portal with many links"></head><body><a href="/login">Log in</a><a href="/privacy">Privacy Policy</a>' +
    ['First big headline today', 'Second story about space', 'Third story on markets', 'Fourth item: weather report', 'Fifth piece of local news', 'Sixth long-form feature'].map((t, i) => '<a href="/story/' + i + '">' + t + '</a>').join('') + '<a href="/story/0#top">First big headline today</a><a href="https://other.example.org/x">Partner site article link</a><a href="javascript:void(0)">Broken javascript link</a></body></html>', { headers: { 'content-type': 'text/html' } });
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
  // 能不能嵌进 App：几种常见的响应头
  const FR: Record<string, Record<string, string>> = {
    'fr-open.example.com': {},
    'fr-deny.example.com': { 'x-frame-options': 'DENY' },
    'fr-same.example.com': { 'x-frame-options': 'SAMEORIGIN' },
    'fr-none.example.com': { 'content-security-policy': "default-src 'self'; frame-ancestors 'none'" },
    'fr-self.example.com': { 'content-security-policy': "frame-ancestors 'self'", 'x-frame-options': 'SAMEORIGIN' },
    'fr-star.example.com': { 'content-security-policy': 'frame-ancestors *', 'x-frame-options': 'DENY' },
    'fr-gh.example.com': { 'content-security-policy': "frame-ancestors 'self' https://*.github.io" },
    'fr-other.example.com': { 'content-security-policy': "frame-ancestors 'self' https://partner.example.org" },
    'fr-two.example.com': { 'content-security-policy': 'frame-ancestors *, frame-ancestors https://partner.example.org' }
  };
  if (FR[u.host]) { hitc('frame-site'); return new Response(new ReadableStream({ pull(c) { c.enqueue(new TextEncoder().encode('x'.repeat(65536))); } }), { headers: { 'content-type': 'text/html', ...FR[u.host] } }); }   // 正文无限长：只看响应头的话照样立刻回来
  if (u.host === 'plain.example.com') return u.protocol === 'https:' ? new Response('<p>ok</p>', { headers: { 'content-type': 'text/html' } }) : new Response('<p>http</p>', { headers: { 'content-type': 'text/html' } });
  if (u.host === 'httponly.example.com') { if (u.protocol === 'https:') throw new TypeError('error sending request: tls handshake eof'); return new Response('<p>http only</p>', { headers: { 'content-type': 'text/html' } }); }
  return realFetch(input, init);
};
Object.defineProperty(Deno, 'resolveDns', { value: async (host: string, type: string) => {
  if (host.endsWith('.invalid') || host === 'nohost.example.com') throw new Deno.errors.NotFound();
  return type === 'A' ? ['93.184.215.14'] : [];
}, configurable: true });
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
ok(r.j.items[0].s === '2025-01-02 来源：维基_百科 量子计算是…… … 第二句' && r.j.items[0].d === '2025-01-02', '摘要去掉开头重复的标题和转义符号、日期整理好了 → ' + r.j.items[0].s);
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
ok(!r.j.ok && r.j.code === 'empty' && /Exa、Tavily/.test(r.j.msg) && /下个月会自动恢复/.test(r.j.msg) && !/1 号/.test(r.j.msg) && /深挖/.test(r.j.msg), '两家都用完：说清楚什么时候恢复、深挖还能用 → ' + r.j.msg);
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
r = await call({ op: 'read', url: 'https://hop.example.com/x' }, TOK2);
ok(r.j.ok && !r.j.cached && siteCalls.length > sc, '另一账号读取同一网页时需建立自己的缓存');
sessionAlive = false;
r = await call({ op: 'read', url: 'https://hop.example.com/x' }, TOK2);
ok(r.st === 401, '服务端撤销会话后不能再取缓存');
sessionAlive = true;
{   // 运行环境不支持查域名：跳过这一步，网页照样能打开（不能因为这个让所有网页都打不开）
  const keep = (Deno as Any).resolveDns;
  Object.defineProperty(Deno, 'resolveDns', { value: undefined, configurable: true }); __test.reset();
  r = await call({ op: 'read', url: 'https://hop.example.com/nodns' });
  ok(r.j.ok || r.j.code !== 'fetch', '运行环境不能查域名时：照样去取网页，不报“连不上” → ' + (r.j.ok ? '取到了' : r.j.code));
  r = await call({ op: 'ping', probe: 'dns' }, null);
  ok(r.j.dnsApi === 'missing', '检查接口能报出“运行环境不能查域名” → ' + r.j.dnsApi);
  Object.defineProperty(Deno, 'resolveDns', { value: keep, configurable: true }); __test.reset();
  r = await call({ op: 'ping', probe: 'dns' }, null);
  ok(r.j.dnsApi === 'works' && r.j.dns === 'nohost', '能查域名时：检查接口报“能用”，不存在的域名认得出来');
}
for (const b2 of ['http://127.0.0.1/', 'http://localhost:8080/', 'http://10.1.2.3/', 'http://192.168.1.1/', 'http://169.254.169.254/latest/meta-data/', 'http://[::1]/', 'http://kong:8000/', 'file:///etc/passwd', 'https://proj.supabase.co/rest/v1/profiles', 'http://0x7f.1/', 'https://a.b.internal/', 'https://user:pw@x.com/', 'https://x.com:22/']) {
  r = await call({ op: 'read', url: b2 });
  ok(!r.j.ok && r.j.code === 'bad', '不能拿来访问内网/本机/自己的数据库：' + b2);
}
r = await call({ op: 'read', url: 'https://redir.example.com/' });
ok(!r.j.ok && r.j.code === 'bad', '公开网站跳转到内网地址：拦住');
r = await call({ op: 'read', url: 'https://files.example.com/a.pdf' });
ok(!r.j.ok && r.j.code === 'notHtml', 'PDF：提示用原网页打开');
r = await call({ op: 'read', url: 'https://gone.example.com/' });
ok(!r.j.ok && r.j.code === 'gone' && /不存在/.test(r.j.msg), '网页不存在：单独的“被删了”代码（手机上先给存档）→ ' + r.j.msg);
r = await call({ op: 'read', url: 'https://home.example.com/' });
ok(!r.j.ok && r.j.code === 'noArticle', '不是文章、链接也太少：说清楚');
r = await call({ op: 'read', url: 'https://nohost.example.com/' });
ok(!r.j.ok && r.j.code === 'nohost' && /找不到 nohost\.example\.com/.test(r.j.msg), '域名根本不存在：说“找不到这个网站” → ' + r.j.msg);
r = await call({ op: 'read', url: 'https://login.example.com/' });
ok(!r.j.ok && r.j.code === 'login', '403：说要登录 → ' + r.j.msg);
r = await call({ op: 'read', url: 'https://busy.example.com/' });
ok(!r.j.ok && r.j.code === 'busy' && /限制了访问次数/.test(r.j.msg), '网站 429：说限流，不再说“可能要登录” → ' + r.j.msg);
r = await call({ op: 'read', url: 'https://down.example.com/' });
ok(!r.j.ok && r.j.code === 'down' && /503/.test(r.j.msg), '网站 5xx：说对方出错 → ' + r.j.msg);
r = await call({ op: 'read', url: 'https://parked.example.com/' });
ok(!r.j.ok && r.j.code === 'noArticle' && r.j.to === 'https://gotowww.parking.example/6d/?parked.example.com', '跳到别的网站的停放页：告诉手机最后跳到了哪 → ' + r.j.to);
r = await call({ op: 'read', url: 'https://portal.example.com/' });
ok(r.j.ok && r.j.kind === 'links' && r.j.title === 'Portal Home' && r.j.desc === 'A portal with many links' && r.j.lang === 'en', '首页这类：给出标题、简介和页面里的链接');
const lk = (r.j.links || []).map((x: Any) => x.t);
ok(lk.length === 7 && lk[0] === 'First big headline today' && lk[6] === 'Partner site article link' && !lk.some((t: string) => /Log in|Privacy|javascript/i.test(t)), '链接：去掉登录、隐私政策、坏链接和重复的，同站的排前面 → ' + lk.length + ' 条');
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
let wb0 = calls.wb || 0;
r = await call({ op: 'read', url: 'https://flaky.example.com/p', at: '20190302000000' });
ok(r.j.ok && r.j.arch === '20190302000000' && calls.wb - wb0 === 2, '档案馆第一次限流（429）：等 1.5 秒自动再试，第二次拿到了');
wb0 = calls.wb;
r = await call({ op: 'read', url: 'https://busyarch.example.com/p', at: '20190302000000' });
ok(!r.j.ok && r.j.code === 'busy' && /互联网档案馆现在太忙/.test(r.j.msg) && calls.wb - wb0 === 2, '档案馆一直限流：只重试一次，然后说清楚是档案馆太忙 → ' + r.j.msg);
r = await call({ op: 'versions', url: 'https://gone.example.com/post/1' });
ok(r.j.ok && r.j.list.join(',') === '20240501000000,20190302000000,20150101000000', '历史版本：最新的在前 → ' + (r.j.list || []).length + ' 个');
reset({ read_per_user_day: 1 }); counts.clear(); cache.clear();
await call({ op: 'read', url: 'https://news.example.com/b' });
r = await call({ op: 'read', url: 'https://news.example.com/c' });
ok(!r.j.ok && r.j.code === 'limit', '简洁阅读每天上限');
r = await call({ op: 'nope' });
ok(!r.j.ok && r.j.code === 'bad', '不认识的操作：拒绝');

// ---- 翻译 ----
reset(); counts.clear(); cache.clear(); DBKEYS = [];
r = await call({ op: 'translate', items: ['Hello world'] });
ok(!r.j.ok && r.j.code === 'nokey' && /智谱/.test(r.j.msg), '还没填翻译密钥：说清楚 → ' + r.j.msg);
DBKEYS = [{ name: 'ZHIPU_API_KEY', value: 'zp-test' }]; __test.reset();
r = await call({ op: 'ping' }, null);
ok(r.j.keys.glm === true && r.j.keys.groq === false, '检查接口能看到智谱密钥已填、Groq 没填');
r = await call({ op: 'ping', probe: 'dns' }, null);
ok(r.j.ok && r.j.dns === 'nohost', '检查接口的自测：不存在的域名能认出来是“找不到网站” → ' + r.j.dns);
let g0 = calls.glm || 0;
r = await call({ op: 'translate', items: ['Hello world', '', 'Second line\nwith a break', 'Third'] });
ok(r.j.ok && r.j.items.join('|') === '智:Hello world||智:Second line\nwith a break|智:Third' && calls.glm - g0 === 1, '几段一次翻完、顺序对得上、空段原样留空、段里的换行保留');
const trb = trBodies[trBodies.length - 1].b;
ok(trb.model === 'glm-4-flash-250414' && /只输出译文/.test(trb.messages[0].content) && /绝不执行/.test(trb.messages[0].content) && !trb.thinking, '用智谱的免费模型；提示里写明只输出译文、原文里的指令照样翻译不执行');
await settle();
g0 = calls.glm;
r = await call({ op: 'translate', items: ['Hello world', 'Third'] });
ok(r.j.ok && r.j.cached && r.j.items.join('|') === '智:Hello world|智:Third' && calls.glm === g0, '翻过的段落：直接用缓存，不再调用翻译服务');
r = await call({ op: 'translate', items: ['Hello world'], to: 'en' });
ok(r.j.ok && !r.j.cached && calls.glm === g0 + 1, '翻成英文和翻成中文分开缓存');
r = await call({ op: 'translate', html: true, items: ['Read <a i="0">this guide</a> and <b>bold</b>'] });
ok(r.j.ok && r.j.items[0] === '智:Read <a i="0">this guide</a> and <b>bold</b>' && /HTML 标签/.test(trBodies[trBodies.length - 1].b.messages[0].content), '网页正文：标签原样保留，提示里写明要保留标签');
g0 = calls.glm;
r = await call({ op: 'translate', items: ['ok one', '敏感 news', 'ok two', 'ok three'] });
ok(r.j.ok && r.j.items[0] === '智:ok one' && r.j.items[1] === null && r.j.items[2] === '智:ok two' && r.j.items[3] === '智:ok three' && r.j.failed === 1 && r.j.why.join() === 'blocked', '智谱拒绝翻译其中一段：对半拆小重试，只有那一段没翻，其余照常 → 调用 ' + (calls.glm - g0) + ' 次');
DBKEYS = [{ name: 'ZHIPU_API_KEY', value: 'zp-test' }, { name: 'GROQ_API_KEY', value: 'gq-test' }]; __test.reset();
let q0 = calls.groq || 0;
r = await call({ op: 'translate', items: ['敏感 news', 'fresh line'] });
ok(r.j.ok && r.j.items[0] === 'G:敏感 news' && r.j.items[1] === '智:fresh line' && !r.j.failed && calls.groq - q0 === 1, '填了 Groq：智谱拒绝的那段交给 Groq 翻，别的段还是智谱');
glmMode = 'busyOnce'; g0 = calls.glm;
r = await call({ op: 'translate', items: ['busy test line'] });
ok(r.j.ok && r.j.items[0] === '智:busy test line' && calls.glm - g0 === 2, '智谱太忙（429）：等一下自动再试一次');
glmMode = 'nomarkers';
r = await call({ op: 'translate', items: ['no marker A', 'no marker B', 'no marker C'] });
ok(r.j.ok && r.j.items.join('|') === '智:no marker A|智:no marker B|智:no marker C', '译文没按编号分段：拆成一段一段重翻，结果照样对得上');
glmMode = 'ok';
DBKEYS = [{ name: 'ZHIPU_API_KEY', value: 'wrong' }]; __test.reset();
r = await call({ op: 'translate', items: ['bad key line'] });
ok(!r.j.ok && r.j.code === 'nokey' && /密钥不对/.test(r.j.msg), '翻译密钥填错：说清楚 → ' + r.j.msg);
DBKEYS = [{ name: 'ZHIPU_API_KEY', value: 'zp-test' }]; __test.reset();
r = await call({ op: 'translate', items: ['x'.repeat(6000), 'y'.repeat(6000), 'z'.repeat(6000), 'w'.repeat(6000), 'v'.repeat(6000), 'u'.repeat(10)] });
ok(!r.j.ok && r.j.code === 'bad', '一次送来太多（超过 3 万字）：拒绝');
r = await call({ op: 'translate', items: [] });
ok(!r.j.ok && r.j.code === 'bad', '没有内容：拒绝');
r = await call({ op: 'translate', items: ['Hello'] }, null);
ok(r.st === 401, '翻译也要登录');
g0 = calls.glm;
const many = Array.from({ length: 30 }, (_, i) => 'Paragraph number ' + i + ' ' + 'word '.repeat(30));
r = await call({ op: 'translate', items: many });
ok(r.j.ok && r.j.items.every((t: string, i: number) => t === '智:' + many[i].trim()) && calls.glm - g0 === 3, '长文章分成几组同时翻（每组不超过约 2400 字），拼回来顺序不乱 → ' + (calls.glm - g0) + ' 组');
reset({ tr_models: { glm: ['gone-model', 'busy-model', 'glm-4-flash-250414'] } });
const tb0 = trBodies.length;
r = await call({ op: 'translate', items: ['model fallback line'] });
ok(r.j.ok && r.j.items[0] === '智:model fallback line' && trBodies.slice(tb0).map((x: Any) => x.b.model).join(',').startsWith('gone-model,busy-model,glm-4-flash-250414'), '第一个模型下线、第二个访问量过大：自动换到下一个模型 → ' + trBodies.slice(tb0).map((x: Any) => x.b.model).join(','));
reset({ tr_models: { glm: ['gone-model'] } });
r = await call({ op: 'translate', items: ['only gone model line'] });
ok(r.j.ok && r.j.items[0] === null && r.j.why.join() === 'upstream', '填的模型全都下线了：这段显示原文，不会卡住');
reset();

// ---------- 在 App 里直接显示原网页：只看响应头判断能不能嵌进来 ----------
const fr = async (url: string, origin = 'https://3855285335-gif.github.io', tok: string | null = TOK) => {
  const res = await handle(new Request('https://proj.supabase.co/functions/v1/chatter-search', { method: 'POST', headers: { 'content-type': 'application/json', origin, ...(tok ? { authorization: 'Bearer ' + tok } : {}) }, body: JSON.stringify({ op: 'frame', url }) }));
  return { st: res.status, j: await res.json() };
};
const expect: [string, boolean, string][] = [
  ['fr-open', true, ''], ['fr-deny', false, 'xfo'], ['fr-same', false, 'xfo'], ['fr-none', false, 'csp'], ['fr-self', false, 'csp'],
  ['fr-star', true, ''], ['fr-gh', true, ''], ['fr-other', false, 'csp'], ['fr-two', false, 'csp']
];
for (const [h, want, why] of expect) {
  const x = await fr('https://' + h + '.example.com/page');
  ok(x.j.ok && x.j.frame === want && x.j.why === why, '能不能嵌进 App：' + h + ' → ' + (want ? '能' : '不能（' + why + '）') + ' 实际 ' + JSON.stringify(x.j));
}
let x = await fr('https://fr-gh.example.com/page', 'https://evil.example.net');
ok(x.j.frame === false, '只允许 *.github.io 的网站：别的网站来问就是“不能”（按请求来源判断）');
x = await fr('https://fr-star.example.com/', 'https://3855285335-gif.github.io', null);
ok(x.st === 401, '要登录才能问');
x = await fr('http://plain.example.com/a');
ok(x.j.frame === true && x.j.url === 'https://plain.example.com/a', 'http 网址：先试 https 版，能用就嵌 https 版 → ' + x.j.url);
x = await fr('http://httponly.example.com/a');
ok(x.j.frame === false && x.j.why === 'http', '只有 http 的网站：嵌不进 https 的 App（浏览器会拦），说清原因');
x = await fr('https://files.example.com/a.pdf');
ok(x.j.frame === false && x.j.why === 'pdf', 'PDF：不嵌（iPhone 的网页框只显示第一页）');
x = await fr('https://nohost.example.com/');
ok(x.j.ok && x.j.frame === null && x.j.code === 'nohost', '找不到网站：交给手机按原因提示 → ' + JSON.stringify(x.j));
x = await fr('https://login.example.com/');
ok(x.j.ok && x.j.frame === null && x.j.code === 'login', '服务器被拒（403）：不代表手机打不开，交给手机先试着显示');
x = await fr('https://redir.example.com/');
ok(x.j.frame === null && x.j.code === 'bad', '跳到内网地址：拒绝（不能拿来探内网）');
x = await fr('http://127.0.0.1/');
ok(!x.j.ok && x.j.code === 'bad', '本机地址：拒绝');
const fs0 = calls['frame-site'] || 0;
x = await fr('https://fr-deny.example.com/page');
ok(x.j.cached === true && (calls['frame-site'] || 0) === fs0, '同一个网址再问：用缓存，不再去取');
const fv = __test.frameVerdict;
ok(fv(new Headers({ 'x-frame-options': 'deny' }), '').frame === false && fv(new Headers({ 'content-security-policy': "frame-ancestors 'none' https://3855285335-gif.github.io" }), '').frame === false, "'none' 和别的写在一起也算不让");
ok(fv(new Headers({ 'content-security-policy': 'frame-ancestors https:' }), 'https://a.github.io').frame === true && fv(new Headers({ 'content-security-policy': 'frame-ancestors http://3855285335-gif.github.io' }), '').frame === false, '写 https: 的允许；协议不对的不允许');
ok(fv(new Headers({ 'content-security-policy-report-only': "frame-ancestors 'none'" }), '').frame === true, '只报告不拦（Report-Only）的不算');
console.log(bad ? `\n有 ${bad} 项没通过` : '\n全部通过');
Deno.exit(bad ? 1 : 0);
