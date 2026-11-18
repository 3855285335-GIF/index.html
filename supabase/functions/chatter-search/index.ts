// Chatter 搜索服务器函数（Supabase 服务器函数，名字 chatter-search）
// 手机 → 这里 → Serper（谷歌的搜索结果）/ 维基百科 / 网页原文。Serper 的密钥只放在服务器上，手机里没有。
//   op: 'search'  搜网页 / 图片 / 视频 / 新闻。同样的搜索 24 小时内直接用缓存，不花额度、不算次数
//   op: 'read'    简洁阅读：服务器把网页取回来，只留正文和图片
//   op: 'ping'    检查服务器是否装好（不用登录）
// 次数上限、营销号名单都在数据库 app_config 表 key='search' 里，改了不用重新部署。
import { Readability } from 'npm:@mozilla/readability@0.6.0';
import { parseHTML } from 'npm:linkedom@0.18.12';

const VER = '20261118-1';
const env = (k: string) => (Deno.env.get(k) || '').trim();
const SB_URL = env('SUPABASE_URL').replace(/\/$/, '');
const SB_HOST = (() => { try { return new URL(SB_URL).hostname; } catch { return ''; } })();
const SRK = env('SUPABASE_SERVICE_ROLE_KEY');
const SERPER = () => env('SERPER_API_KEY');
const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const DAY = 86400000, TTL = DAY, ALL = '00000000-0000-0000-0000-000000000000';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const WIKI_UA = 'ChatterSearch/1.0 (https://github.com/3855285335-gif/index.html)';
const MAX_PAGE = 3 * 1024 * 1024;

// deno-lint-ignore no-explicit-any
type Any = any;
const json = (o: Any, st = 200) => new Response(JSON.stringify(o), { status: st, headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' } });
const fail = (code: string, msg: string, st = 200) => json({ ok: false, code, msg }, st);
const str = (v: Any, n = 400) => (typeof v === 'string' && v.trim()) ? v.trim().slice(0, n) : undefined;
const link = (v: Any) => (typeof v === 'string' && /^https?:\/\//i.test(v)) ? v.slice(0, 2000) : undefined;
const num = (v: Any) => (typeof v === 'number' && isFinite(v)) ? Math.round(v) : undefined;
function bg(p: Promise<unknown>) { p.catch(() => {}); try { (globalThis as Any).EdgeRuntime?.waitUntil?.(p); } catch { /* 没有也行 */ } }
async function tfetch(u: string, init: RequestInit = {}, ms = 8000) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), ms);
  try { return await fetch(u, { ...init, signal: ac.signal }); } finally { clearTimeout(t); }
}
function dbh(extra: Record<string, string> = {}) {
  const h: Record<string, string> = { apikey: SRK, 'Content-Type': 'application/json', ...extra };
  if (!SRK.startsWith('sb_')) h.Authorization = 'Bearer ' + SRK;   // 新式密钥（sb_secret_…）不能放在 Authorization 里
  return h;
}

/* ---------- 配置（数据库里改，1 分钟内生效） ---------- */
const CFG_DEF = { enabled: true, per_user_day: 80, read_per_user_day: 300, month_cap: 2400 };
let CFG: Any = null, CFG_AT = 0;
async function cfg() {
  if (CFG && Date.now() - CFG_AT < 60000) return CFG;
  try {
    const r = await tfetch(SB_URL + '/rest/v1/app_config?key=eq.search&select=value', { headers: dbh() }, 4000);
    const a = r.ok ? await r.json() : null;
    CFG = { ...CFG_DEF, ...((a && a[0] && a[0].value) || {}) };
  } catch { CFG = CFG || { ...CFG_DEF }; }
  CFG_AT = Date.now(); return CFG;
}

/* ---------- 谁在用（用登录凭证向登录服务确认，5 分钟内不重复问） ---------- */
const UIDS = new Map<string, { uid: string; at: number }>();
async function uidOf(req: Request) {
  const tok = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!tok || tok.split('.').length !== 3) return null;
  const hit = UIDS.get(tok); if (hit && Date.now() - hit.at < 300000) return hit.uid;
  const r = await tfetch(SB_URL + '/auth/v1/user', { headers: { apikey: SRK, Authorization: 'Bearer ' + tok } }, 5000);
  if (!r.ok) return null;
  const u = await r.json().catch(() => null); if (!u || !u.id) return null;
  if (UIDS.size > 500) UIDS.clear();
  UIDS.set(tok, { uid: u.id, at: Date.now() }); return u.id as string;
}

/* ---------- 缓存和计数 ---------- */
async function sha(s: string) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(b)).map(x => x.toString(16).padStart(2, '0')).join('').slice(0, 40);
}
async function cget(k: string) {
  try {
    const r = await tfetch(SB_URL + '/rest/v1/search_cache?k=eq.' + k + '&select=v,at', { headers: dbh() }, 4000);
    if (!r.ok) return null;
    const a = await r.json(); const x = a && a[0];
    if (!x || Date.now() - Date.parse(x.at) > TTL) return null;
    return x.v;
  } catch { return null; }
}
async function cput(k: string, v: Any) {
  try { await tfetch(SB_URL + '/rest/v1/search_cache?on_conflict=k', { method: 'POST', headers: dbh({ Prefer: 'resolution=merge-duplicates,return=minimal' }), body: JSON.stringify({ k, v, at: new Date().toISOString() }) }, 5000); } catch { /* 存不上下次重搜 */ }
  if (Math.random() < 0.03) await sweep();
}
async function sweep() {   // 顺手清掉过期缓存、40 天前的计数，数据库不会越积越大
  const old = new Date(Date.now() - TTL).toISOString(), d40 = new Date(Date.now() - 40 * DAY).toISOString().slice(0, 10);
  const del = (p: string) => tfetch(SB_URL + '/rest/v1/' + p, { method: 'DELETE', headers: dbh({ Prefer: 'return=minimal' }) }, 6000).catch(() => null);
  await Promise.all([del('search_cache?at=lt.' + old), del('search_usage?day=lt.' + d40)]);
}
class Oops extends Error { code: string; constructor(code: string, msg: string) { super(msg); this.code = code; } }
async function bump(uid: string, kind: string, limit: number, month = false) {
  const r = await tfetch(SB_URL + '/rest/v1/rpc/search_bump', { method: 'POST', headers: dbh(), body: JSON.stringify({ p_uid: uid, p_kind: kind, p_limit: Number(limit) || 0, p_month: month }) }, 5000);
  if (r.status === 404) throw new Oops('nosql', '数据库部分还没装好：要先运行搜索那份 SQL');
  if (!r.ok) throw new Oops('db', '数据库出错（' + r.status + '），稍后再试');
  return Number(await r.json());
}

/* ---------- 搜索 ---------- */
const TYPES: Record<string, string> = { web: 'search', images: 'images', videos: 'videos', news: 'news' };
const TBS = ['', 'qdr:d', 'qdr:w', 'qdr:m', 'qdr:y'];
const GLS = ['', 'us', 'hk', 'tw', 'sg', 'jp', 'gb'];
const HLS = ['zh-cn', 'zh-tw', 'en', 'ja'];
function shape(type: string, j: Any) {
  j = j || {};
  if (type === 'images') return { items: (j.images || []).slice(0, 100).map((i: Any) => ({ t: str(i.title, 200), img: link(i.imageUrl), th: link(i.thumbnailUrl), w: num(i.imageWidth), h: num(i.imageHeight), u: link(i.link), src: str(i.domain || i.source, 80) })).filter((x: Any) => x.img || x.th) };
  if (type === 'videos') return { items: (j.videos || []).map((v: Any) => ({ t: str(v.title, 200), u: link(v.link), s: str(v.snippet), img: link(v.imageUrl), dur: str(v.duration, 12), src: str(v.source, 60), ch: str(v.channel, 80), d: str(v.date, 40) })).filter((x: Any) => x.u) };
  if (type === 'news') return { items: (j.news || []).map((v: Any) => ({ t: str(v.title, 200), u: link(v.link), s: str(v.snippet), img: link(v.imageUrl), src: str(v.source, 60), d: str(v.date, 40) })).filter((x: Any) => x.u) };
  const o: Any = { items: (j.organic || []).map((v: Any) => ({ t: str(v.title, 200), u: link(v.link), s: str(v.snippet, 400), d: str(v.date, 40) })).filter((x: Any) => x.u) };
  const kg = j.knowledgeGraph;
  if (kg && kg.title) o.kg = { t: str(kg.title, 120), type: str(kg.type, 60), s: str(kg.description, 600), src: str(kg.descriptionSource, 40), u: link(kg.descriptionLink) || link(kg.website), img: link(kg.imageUrl),
    attrs: (kg.attributes && typeof kg.attributes === 'object') ? Object.entries(kg.attributes).slice(0, 6).map(([k, v]) => [str(k, 40), str(String(v), 120)]).filter(x => x[0] && x[1]) : undefined };
  const ab = j.answerBox;
  if (ab && (ab.answer || ab.snippet)) o.ans = { t: str(ab.answer || ab.snippet, 600), title: str(ab.title, 200), u: link(ab.link) };
  if (Array.isArray(j.relatedSearches)) o.rel = j.relatedSearches.map((x: Any) => str(x && x.query, 80)).filter(Boolean).slice(0, 8);
  return o;
}
function loose(a: Any, b: Any) {
  const n = (x: Any) => String(x || '').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
  const x = n(a), y = n(b); return !!x && !!y && (x.includes(y) || y.includes(x));
}
function clip(t: string, n = 280) {
  t = t.replace(/\s+/g, ' ').trim(); if (t.length <= n) return t;
  const cut = t.slice(0, n), i = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('. '), cut.lastIndexOf('！'), cut.lastIndexOf('？'));
  return i > n * 0.5 ? cut.slice(0, i + 1) : cut + '…';
}
async function wiki(q: string) {   // 百科卡片：谷歌没给知识卡片时，用维基百科的第一条（标题要和搜的词对得上，不然不显示）
  if (q.length > 60) return null;
  const zh = /[㐀-鿿]/.test(q), host = zh ? 'zh.wikipedia.org' : 'en.wikipedia.org';
  const p = new URLSearchParams({ action: 'query', format: 'json', formatversion: '2', generator: 'search', gsrsearch: q, gsrlimit: '1', gsrnamespace: '0', prop: 'extracts|pageimages|info', exintro: '1', explaintext: '1', piprop: 'thumbnail', pithumbsize: '240', inprop: 'url|displaytitle', redirects: '1' });
  if (zh) p.set('variant', 'zh-cn');
  const r = await tfetch('https://' + host + '/w/api.php?' + p, { headers: { 'User-Agent': WIKI_UA, 'Api-User-Agent': WIKI_UA, 'Accept-Language': zh ? 'zh-CN' : 'en' } }, 5000);
  if (!r.ok) return null;
  const j = await r.json(); const pg = j && j.query && j.query.pages && j.query.pages[0];
  if (!pg || pg.missing) return null;
  const title = String(pg.displaytitle || pg.title || '').replace(/<[^>]+>/g, '');
  const ex = String(pg.extract || '').trim();
  if (ex.length < 20 || /may refer to|可以指|可能指|可指/.test(ex.slice(0, 80))) return null;
  if (!loose(title, q) && !loose(pg.title, q)) return null;
  const u = link(pg.fullurl);
  return { t: title.slice(0, 120), s: clip(ex), img: link(pg.thumbnail && pg.thumbnail.source), u: u && u.replace('://' + host, '://' + host.replace('.wikipedia', '.m.wikipedia')), src: '维基百科' };
}
async function doSearch(uid: string, b: Any, c: Any) {
  const type = TYPES[b.type] ? b.type : 'web';
  const q = String(b.q || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!q) return fail('bad', '没有要搜的内容');
  const page = Math.min(10, Math.max(1, parseInt(b.page) || 1));
  const tbs = TBS.includes(b.tbs) ? b.tbs : '', gl = GLS.includes(b.gl) ? b.gl : '', hl = HLS.includes(b.hl) ? b.hl : 'zh-cn';
  const key = 's' + await sha([type, q.toLowerCase(), page, tbs, gl, hl].join('|'));
  const hit = await cget(key);
  if (hit) return json({ ok: true, cached: true, ...hit });
  if (!SERPER()) return fail('nokey', '搜索还没开通：服务器里还没填 Serper 的密钥');
  const n = await bump(uid, 's', c.per_user_day);
  if (n < 0) return fail('limit', '今天搜了 ' + c.per_user_day + ' 次，到上限了，明天再来（搜过的词再搜不算次数）');
  if (await bump(ALL, 'month', c.month_cap, true) < 0) return fail('month', '这个月的搜索次数用完了（所有人合计），下个月 1 号恢复');
  const body: Any = { q, page, hl }; if (gl) body.gl = gl; if (tbs) body.tbs = tbs; if (type !== 'images') body.num = 10;
  const wikiP = (type === 'web' && page === 1) ? wiki(q).catch(() => null) : Promise.resolve(null);
  let r: Response, j: Any;
  try {
    r = await tfetch('https://google.serper.dev/' + TYPES[type], { method: 'POST', headers: { 'X-API-KEY': SERPER(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, 9000);
    j = await r.json().catch(() => null);
  } catch { return fail('upstream', '搜索服务没响应，稍后再试'); }
  if (!r.ok) {
    const m = String((j && j.message) || '');
    if (/credit/i.test(m)) return fail('credits', 'Serper 的额度用完了：要去 Serper 充值，或者换一个密钥');
    if (r.status === 401 || r.status === 403) return fail('nokey', 'Serper 的密钥不对：检查服务器里填的 SERPER_API_KEY');
    if (r.status === 429) return fail('busy', '搜得太快了，等几秒再试');
    return fail('upstream', '搜索服务出错（' + r.status + '）');
  }
  const out: Any = shape(type, j);
  if (type === 'web' && page === 1 && !out.kg) { const w = await wikiP; if (w) out.wiki = w; }
  out.type = type; out.q = q; out.page = page;
  bg(cput(key, out));
  return json({ ok: true, cached: false, left: Math.max(0, c.per_user_day - n), ...out });
}

/* ---------- 简洁阅读 ---------- */
function safeUrl(s: Any) {   // 只取公开网站：不让拿来访问内网、本机、自己的数据库接口
  let u: URL; try { u = new URL(String(s || '').trim()); } catch { return null; }
  if (!/^https?:$/.test(u.protocol) || u.username || u.password) return null;
  const h = u.hostname.toLowerCase().replace(/\.$/, '');
  if (!h || h.startsWith('[') || !h.includes('.')) return null;
  if (/(^|\.)(localhost|local|internal|intranet|lan|home|corp|localdomain|arpa)$/.test(h)) return null;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) {
    const [a, b2] = h.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b2 === 254) || (a === 172 && b2 >= 16 && b2 <= 31) || (a === 192 && b2 === 168) || (a === 100 && b2 >= 64 && b2 <= 127) || (a === 198 && (b2 === 18 || b2 === 19))) return null;
  }
  if (SB_HOST && h === SB_HOST) return null;
  if (u.port && !['80', '443', '8080', '8443'].includes(u.port)) return null;
  u.hash = ''; return u;
}
async function readCapped(r: Response, max: number) {
  const rd = r.body && r.body.getReader();
  if (!rd) return new Uint8Array(await r.arrayBuffer()).slice(0, max);
  const parts: Uint8Array[] = []; let n = 0;
  while (true) {
    const { done, value } = await rd.read(); if (done) break;
    parts.push(value); n += value.length;
    if (n >= max) { try { await rd.cancel(); } catch { /* 已经够了 */ } break; }
  }
  const out = new Uint8Array(Math.min(n, max)); let o = 0;
  for (const p of parts) { const take = Math.min(p.length, out.length - o); out.set(p.subarray(0, take), o); o += take; if (o >= out.length) break; }
  return out;
}
function decode(buf: Uint8Array, ct: string) {   // 国内很多网站还是 GBK 编码
  let cs = (/charset=["']?([\w-]+)/i.exec(ct) || [])[1];
  if (!cs) { const head = new TextDecoder('windows-1252').decode(buf.subarray(0, 4096)); cs = (/<meta[^>]+charset=["']?([\w-]+)/i.exec(head) || [])[1]; }
  cs = (cs || 'utf-8').toLowerCase(); if (cs === 'gb2312' || cs === 'gbk') cs = 'gb18030';
  try { return new TextDecoder(cs).decode(buf); } catch { return new TextDecoder('utf-8').decode(buf); }
}
async function grab(u0: URL) {
  let cur = u0;
  for (let hop = 0; hop < 6; hop++) {
    let r: Response;
    try { r = await tfetch(cur.href, { redirect: 'manual', headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5', 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' } }, 9000); }
    catch (e) { throw new Oops('fetch', (e as Any)?.name === 'AbortError' ? '这个网页太久没响应' : '这个网页连不上'); }
    if (r.status >= 300 && r.status < 400) {
      const loc = r.headers.get('location'); try { await r.body?.cancel(); } catch { /* 不要正文 */ }
      if (!loc) break;
      const nx = safeUrl(new URL(loc, cur).href); if (!nx) throw new Oops('bad', '这个网页跳到了不能打开的地址');
      cur = nx; continue;
    }
    if (!r.ok) {
      try { await r.body?.cancel(); } catch { /* 不要正文 */ }
      throw new Oops('fetch', (r.status === 401 || r.status === 403) ? '这个网站不让直接取内容（可能要登录）' : r.status === 404 ? '这个网页已经不存在了' : '这个网页取不到（' + r.status + '）');
    }
    const ct = (r.headers.get('content-type') || '').toLowerCase();
    if (ct && !/html|xml|text\/plain/.test(ct)) { try { await r.body?.cancel(); } catch { /* 不要正文 */ } throw new Oops('notHtml', /pdf/.test(ct) ? '这是 PDF 文件，用原网页打开' : '这不是网页（是文件），用原网页打开'); }
    return { html: decode(await readCapped(r, MAX_PAGE), ct), url: cur.href };
  }
  throw new Oops('fetch', '这个网页跳转太多次了');
}
const escT = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escA = (s: string) => escT(s).replace(/"/g, '&quot;');
function abs(v: Any, base: string) { if (!v) return ''; try { const u = new URL(String(v).trim(), base); return /^https?:$/.test(u.protocol) ? u.href : ''; } catch { return ''; } }
const KEEP = new Set(['p', 'br', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'em', 'strong', 'b', 'i', 'u', 's', 'sub', 'sup', 'a', 'img', 'figure', 'figcaption', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'hr', 'div']);
const DROP = new Set(['script', 'style', 'noscript', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'select', 'textarea', 'svg', 'canvas', 'video', 'audio', 'template', 'link', 'meta', 'nav', 'aside', 'footer', 'header']);
function clean(content: string, base: string) {   // 只留白名单里的标签；属性只留链接和图片地址
  const { document } = parseHTML('<!doctype html><html><body><div id="chx">' + content + '</div></body></html>');
  const root = document.getElementById('chx'); const out: string[] = []; let text = 0, imgs = 0;
  const walk = (node: Any) => {
    for (const ch of Array.from(node.childNodes) as Any[]) {
      if (ch.nodeType === 3) { const t = String(ch.textContent || ''); text += t.replace(/\s+/g, '').length; out.push(escT(t)); continue; }
      if (ch.nodeType !== 1) continue;
      let tag = String(ch.tagName || '').toLowerCase();
      if (DROP.has(tag)) continue;
      if (tag === 'h1') tag = 'h2';
      if (tag === 'section' || tag === 'article' || tag === 'main') tag = 'div';
      if (!KEEP.has(tag)) { walk(ch); continue; }
      if (tag === 'img') {
        const ss = String(ch.getAttribute('srcset') || '').split(',').pop() || '';
        const src = abs(ch.getAttribute('src') || ss.trim().split(/\s+/)[0], base); if (!src) continue;
        imgs++; const alt = String(ch.getAttribute('alt') || '').slice(0, 200);
        out.push('<img src="' + escA(src) + '"' + (alt ? ' alt="' + escA(alt) + '"' : '') + '>'); continue;
      }
      if (tag === 'br' || tag === 'hr') { out.push('<' + tag + '>'); continue; }
      if (tag === 'a') { const h = abs(ch.getAttribute('href'), base); out.push(h ? '<a href="' + escA(h) + '">' : ''); walk(ch); out.push(h ? '</a>' : ''); continue; }
      out.push('<' + tag + '>'); walk(ch); out.push('</' + tag + '>');
    }
  };
  if (root) walk(root);
  const html = out.join('').replace(/<(p|div|li|figure)>\s*<\/\1>/g, '').replace(/\n{3,}/g, '\n\n');
  return { html: html.slice(0, 400000), text, imgs };
}
function normDate(v: Any) { const t = Date.parse(String(v || '')); return isFinite(t) && t > 0 ? new Date(t).toISOString().slice(0, 10) : undefined; }
const hostOf = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
function extract(html: string, base: string) {
  const { document } = parseHTML(html);
  for (const im of Array.from(document.querySelectorAll('img')) as Any[]) {   // 懒加载的图：真地址藏在 data-src 之类里
    const ds = im.getAttribute('data-src') || im.getAttribute('data-original') || im.getAttribute('data-lazy-src') || im.getAttribute('data-actualsrc') || im.getAttribute('data-url');
    const src = im.getAttribute('src') || '';
    if (ds && (!src || /^data:|blank|placeholder|loading|grey|lazy|spacer/i.test(src))) im.setAttribute('src', ds);
  }
  const meta = (sel: string) => { const el = document.querySelector(sel); return (el && el.getAttribute('content')) || ''; };
  const ogImg = meta('meta[property="og:image"]') || meta('meta[name="twitter:image"]');
  const site = meta('meta[property="og:site_name"]');
  const pub = meta('meta[property="article:published_time"]') || meta('meta[name="pubdate"]') || meta('meta[name="publishdate"]') || meta('meta[itemprop="datePublished"]');
  const lang = (document.documentElement && document.documentElement.getAttribute('lang')) || '';
  let r: Any = null;
  try { r = new Readability(document as Any, { charThreshold: 200, keepClasses: false }).parse(); } catch { r = null; }
  if (!r || !r.content || (r.length || 0) < 140) return null;
  const c = clean(r.content, base);
  if (c.text < 100) return null;
  return { u: base, title: str(r.title, 200) || hostOf(base), site: str(r.siteName, 60) || str(site, 60) || hostOf(base), by: str(r.byline, 80), date: normDate(r.publishedTime || pub), lang: str(r.lang || lang, 20), html: c.html, len: c.text, img: c.imgs ? undefined : (abs(ogImg, base) || undefined) };
}
async function doRead(uid: string, b: Any, c: Any) {
  const u0 = safeUrl(b.url); if (!u0) return fail('bad', '这个网址不能打开');
  const key = 'r' + await sha(u0.href);
  const hit = await cget(key);
  if (hit) return json({ ok: true, cached: true, ...hit });
  if (await bump(uid, 'r', c.read_per_user_day) < 0) return fail('limit', '今天简洁阅读打开太多次了，明天再来；可以先点“原网页”');
  const got = await grab(u0);
  const art = extract(got.html, got.url);
  if (!art) return fail('noArticle', '这个网页不是文章，没法简洁阅读');
  bg(cput(key, art));
  return json({ ok: true, cached: false, ...art });
}

/* ---------- 入口 ---------- */
export async function handle(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return fail('bad', '只接受 POST', 405);
  let b: Any; try { b = await req.json(); } catch { return fail('bad', '请求格式不对', 400); }
  if (!b || typeof b !== 'object') return fail('bad', '请求格式不对', 400);
  if (b.op === 'ping') return json({ ok: true, v: VER, key: !!SERPER() });
  let uid: string | null = null; try { uid = await uidOf(req); } catch { uid = null; }
  if (!uid) return fail('auth', '登录过期了，重新登录一下', 401);
  try {
    const c = await cfg();
    if (c.enabled === false) return fail('off', '搜索暂时关闭了');
    if (b.op === 'search') return await doSearch(uid, b, c);
    if (b.op === 'read') return await doRead(uid, b, c);
    return fail('bad', '不认识的操作');
  } catch (e) {
    if (e instanceof Oops) return fail(e.code, e.message);
    console.error('chatter-search', e);
    return fail('server', '服务器出错了：' + String((e as Any)?.message || e).slice(0, 120));
  }
}
export const __test = { reset() { CFG = null; CFG_AT = 0; UIDS.clear(); } };
if (!env('CHATTER_TEST')) Deno.serve(handle);
