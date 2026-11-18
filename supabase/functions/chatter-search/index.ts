// Chatter 搜索服务器函数（Supabase 服务器函数，名字 chatter-search）
// 手机 → 这里 → Exa / Tavily（网页搜索）、维基百科、互联网档案馆、论文库、GitHub、Hacker News、网页原文。
// 搜索服务的密钥只放在服务器上，手机里没有。
//   op: 'search'    搜网页 / 图片 / 视频 / 新闻 / 深挖。同样的搜索 24 小时内直接用缓存，不花额度、不算次数
//                   网页、新闻、视频默认先用 Exa，Exa 用完自动换 Tavily；图片先用 Tavily
//                   深挖：维基百科、互联网档案馆、论文库（OpenAlex）、GitHub、Hacker News，全部免费
//   op: 'read'      简洁阅读：服务器把网页取回来，只留正文和图片；at='latest' 或时间戳 = 看互联网档案馆的存档
//   op: 'versions'  这个网页在互联网档案馆里有哪些历史版本
//   op: 'usage'     这个月 Exa、Tavily 各用了多少次
//   op: 'ping'      检查服务器是否装好（不用登录）
// 次数上限、搜索顺序、营销号名单都在数据库 app_config 表 key='search' 里，改了不用重新部署。
import { Readability } from 'npm:@mozilla/readability@0.6.0';
import { parseHTML } from 'npm:linkedom@0.18.12';

const VER = '20261118-5';
const env = (k: string) => (Deno.env.get(k) || '').trim();
const SB_URL = env('SUPABASE_URL').replace(/\/$/, '');
const SB_HOST = (() => { try { return new URL(SB_URL).hostname; } catch { return ''; } })();
// 访问数据库的密钥：和推送函数一样，优先用新式密钥（SUPABASE_SECRET_KEYS），没有再用旧的 service_role 密钥
const pickKey = (name: string, legacy: string) => {
  try { const j = JSON.parse(env(name) || '{}'); if (j && j.default) return String(j.default); const v = j && Object.values(j)[0]; if (v) return String(v); } catch { /* 不是 JSON：改用旧版变量 */ }
  return env(legacy);
};
const SRK = pickKey('SUPABASE_SECRET_KEYS', 'SUPABASE_SERVICE_ROLE_KEY');
const PUBK = pickKey('SUPABASE_PUBLISHABLE_KEYS', 'SUPABASE_ANON_KEY');
// 搜索服务的密钥：先看服务器环境变量，没有就用数据库 search_keys 表里的（只有服务器能读，改了 1 分钟内生效）
let DBK: Record<string, string> = {}, DBK_AT = 0;
const sec = (k: string) => env(k) || DBK[k] || '';
const KEY: Record<string, () => string> = { exa: () => sec('EXA_API_KEY'), tavily: () => sec('TAVILY_API_KEY') };
const NAME: Record<string, string> = { exa: 'Exa', tavily: 'Tavily' };
const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const DAY = 86400000, TTL = DAY, ALL = '00000000-0000-0000-0000-000000000000';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const BOT_UA = 'ChatterSearch/1.0 (https://github.com/3855285335-gif/index.html)';
const MAX_PAGE = 3 * 1024 * 1024;
const VID_SITES = ['youtube.com', 'bilibili.com', 'vimeo.com'];
const CJK = /[\u3400-\u9fff]/;

// deno-lint-ignore no-explicit-any
type Any = any;
const json = (o: Any, st = 200) => new Response(JSON.stringify(o), { status: st, headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' } });
const fail = (code: string, msg: string, st = 200) => json({ ok: false, code, msg }, st);
const str = (v: Any, n = 400) => (typeof v === 'string' && v.trim()) ? v.trim().slice(0, n) : undefined;
const link = (v: Any) => (typeof v === 'string' && /^https?:\/\//i.test(v)) ? v.slice(0, 2000) : undefined;
const num = (v: Any) => (typeof v === 'number' && isFinite(v)) ? Math.round(v) : undefined;
const day10 = (v: Any) => { const t = Date.parse(String(v || '')); return isFinite(t) && t > 0 ? new Date(t).toISOString().slice(0, 10) : undefined; };
const strip = (s: Any) => String(s || '').replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
// Tavily 的摘要是带排版符号的长文（###、[...]、**、换行），整理成一两句干净的话
const tidy = (v: Any, n = 220) => { const t = String(v || '').replace(/^\s*Title:[^\n]*\n/i, '').replace(/\[\.\.\.\]/g, '…').replace(/^\s*#{1,6}\s*/gm, '').replace(/\*\*|__|`/g, '').replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\s+/g, ' ').trim(); return t ? (t.length > n ? t.slice(0, n) + '…' : t) : undefined; };
const hostOf = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
function bg(p: Promise<unknown>) { p.catch(() => {}); try { (globalThis as Any).EdgeRuntime?.waitUntil?.(p); } catch { /* 没有也行 */ } }
async function tfetch(u: string, init: RequestInit = {}, ms = 8000) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), ms);
  try { return await fetch(u, { ...init, signal: ac.signal }); } finally { clearTimeout(t); }
}
async function getJson(u: string, headers: Record<string, string> = {}, ms = 7000) {
  const r = await tfetch(u, { headers: { 'User-Agent': BOT_UA, Accept: 'application/json', ...headers } }, ms);
  if (!r.ok) throw new Error(u.split('?')[0] + ' ' + r.status);
  return await r.json();
}
async function postJson(u: string, headers: Record<string, string>, body: Any, ms = 12000) {
  const r = await tfetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) }, ms);
  const j = await r.json().catch(() => null);
  return { status: r.status, ok: r.ok, j };
}
function dbh(extra: Record<string, string> = {}) {
  const h: Record<string, string> = { apikey: SRK, 'Content-Type': 'application/json', ...extra };
  if (SRK.split('.').length === 3) h.Authorization = 'Bearer ' + SRK;   // 旧版 service_role 密钥本身是登录凭证格式；新式密钥（sb_secret_…）不能放在这里
  return h;
}
const monthStart = () => { const d = new Date(Date.now() + 8 * 3600000); return d.toISOString().slice(0, 8) + '01'; };   // 北京时间的本月 1 号

/* ---------- 配置（数据库里改，1 分钟内生效） ---------- */
const CFG_DEF = { enabled: true, per_user_day: 1000000000, read_per_user_day: 1000000000, deep_per_user_day: 1000000000, order: ['exa', 'tavily'], img_order: ['tavily', 'exa'], exa_free: 2500, tavily_free: 1000 };
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

async function loadKeys() {
  if (DBK_AT && Date.now() - DBK_AT < 60000) return;
  try {
    const r = await tfetch(SB_URL + '/rest/v1/search_keys?select=name,value', { headers: dbh() }, 4000);
    if (r.ok) { const o: Record<string, string> = {}; for (const x of await r.json()) if (x && x.name && x.value) o[x.name] = String(x.value).trim(); DBK = o; }
  } catch { /* 读不到就只用环境变量 */ }
  DBK_AT = Date.now();
}

/* ---------- 谁在用（用登录凭证向登录服务确认，5 分钟内不重复问） ---------- */
const UIDS = new Map<string, { uid: string; at: number }>();
async function uidOf(req: Request) {
  const tok = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!tok || tok.split('.').length !== 3) return null;
  const hit = UIDS.get(tok); if (hit && Date.now() - hit.at < 300000) return hit.uid;
  const r = await tfetch(SB_URL + '/auth/v1/user', { headers: { apikey: PUBK || SRK, Authorization: 'Bearer ' + tok } }, 5000);
  if (!r.ok) return null;
  const u = await r.json().catch(() => null); if (!u || !u.id) return null;
  if (UIDS.size > 500) UIDS.clear();
  UIDS.set(tok, { uid: u.id, at: Date.now() }); return u.id as string;
}

/* ---------- 缓存、记号和计数 ---------- */
async function sha(s: string) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(b)).map(x => x.toString(16).padStart(2, '0')).join('').slice(0, 40);
}
async function cgetMany(keys: string[]) {   // 一次查好几个键（缓存和“用完了”的记号放在同一张表里）
  const out: Record<string, { v: Any; at: number }> = {};
  try {
    const r = await tfetch(SB_URL + '/rest/v1/search_cache?k=in.(' + keys.join(',') + ')&select=k,v,at', { headers: dbh() }, 4000);
    if (!r.ok) return out;
    for (const x of await r.json()) out[x.k] = { v: x.v, at: Date.parse(x.at) };
  } catch { /* 查不到就当没有 */ }
  return out;
}
async function cget(k: string) { const x = (await cgetMany([k]))[k]; return x && Date.now() - x.at <= TTL ? x.v : null; }
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
async function usage() {
  try {
    const r = await tfetch(SB_URL + '/rest/v1/search_usage?uid=eq.' + ALL + '&day=eq.' + monthStart() + '&select=kind,n', { headers: dbh() }, 4000);
    const a = r.ok ? await r.json() : [];
    const o: Record<string, number> = { exa: 0, tavily: 0 };
    for (const x of a) if (/^m:/.test(x.kind)) o[x.kind.slice(2)] = x.n;
    return o;
  } catch { return { exa: 0, tavily: 0 }; }
}

/* ---------- 两家网页搜索 ---------- */
const SINCE: Record<string, number> = { day: 1, week: 7, month: 31, year: 366 };
function srcErr(s: string, status: number, j: Any) {   // 把各家的出错说成人话；“用完了”单独标出来，好自动换下一家
  const m = String((j && (j.error || j.message || j.detail && (j.detail.error || j.detail))) || '');
  if (status === 402 || status === 432 || status === 433 || /credit|balance|quota|usage limit|insufficient/i.test(m)) return new Oops('empty', NAME[s] + ' 这个月的免费次数用完了');
  if (status === 401 || status === 403) return new Oops('badkey', NAME[s] + ' 的密钥不对：检查服务器里填的密钥');
  if (status === 429) return new Oops('busy', '搜得太快了，等几秒再试');
  return new Oops('upstream', NAME[s] + ' 出错（' + status + '）');
}
async function exa(type: string, q: string, tbs: string, sites: string[] = []) {
  const body: Any = { query: q, type: 'lite', numResults: 10, contents: { highlights: true } };
  if (SINCE[tbs]) body.startPublishedDate = new Date(Date.now() - SINCE[tbs] * DAY).toISOString();
  if (type === 'news') body.category = 'news';
  if (type === 'videos') body.includeDomains = VID_SITES;
  if (sites.length) body.includeDomains = sites;   // “site:网址”：Exa 要用这个参数，不认搜索词里的 site:
  const h = { 'x-api-key': KEY.exa() };
  let r = await postJson('https://api.exa.ai/search', h, body);
  if (r.status === 400) { delete body.contents; r = await postJson('https://api.exa.ai/search', h, body); }   // 万一简版不支持摘要，退一步只要标题
  if (!r.ok) throw srcErr('exa', r.status, r.j);
  const res = ((r.j && r.j.results) || []).filter((x: Any) => link(x.url));
  if (type === 'images') return { items: res.filter((x: Any) => link(x.image)).map((x: Any) => ({ t: str(x.title, 200), img: link(x.image), th: link(x.image), u: link(x.url), src: hostOf(x.url) })) };
  if (type === 'videos') return { items: res.map((x: Any) => ({ t: str(x.title, 200), u: link(x.url), img: link(x.image), src: hostOf(x.url), ch: str(x.author, 80), d: day10(x.publishedDate) })) };
  return { items: res.map((x: Any) => ({ t: str(x.title, 200), u: link(x.url), s: tidy(Array.isArray(x.highlights) ? x.highlights.join(' … ') : x.text, 300), d: day10(x.publishedDate), img: type === 'news' ? link(x.image) : undefined })) };
}
async function tavily(type: string, q: string, tbs: string, sites: string[] = []) {
  const body: Any = { query: q, search_depth: 'basic', max_results: type === 'images' ? 20 : 10, topic: type === 'news' ? 'news' : 'general' };
  if (SINCE[tbs]) body.time_range = tbs;
  if (CJK.test(q)) body.language = 'zh-cn';
  if (type === 'images') { body.include_images = true; body.include_image_descriptions = true; }
  if (type === 'videos') body.include_domains = VID_SITES;
  if (sites.length) body.include_domains = sites;
  if (type === 'news') body.include_published_date = true;
  const h = { Authorization: 'Bearer ' + KEY.tavily() };
  let r = await postJson('https://api.tavily.com/search', h, body);
  if (r.status === 400 && body.language) { delete body.language; r = await postJson('https://api.tavily.com/search', h, body); }
  if (!r.ok) throw srcErr('tavily', r.status, r.j);
  const res = ((r.j && r.j.results) || []).filter((x: Any) => link(x.url));
  if (type === 'images') {
    const items: Any[] = [], seen = new Set<string>();
    const add = (im: Any, page?: Any) => { const u = link(typeof im === 'string' ? im : im && im.url); if (!u || seen.has(u)) return; seen.add(u); items.push({ t: str(im && im.title, 200) || str(page && page.title, 200) || str(im && im.description, 200), img: u, th: u, u: page ? link(page.url) : undefined, src: page ? hostOf(page.url) : hostOf(u) }); };   // 图片自带的是网页标题（中文）和一句英文描述：优先显示标题
    res.forEach((p: Any) => (p.images || []).forEach((im: Any) => add(im, p)));
    ((r.j && r.j.images) || []).forEach((im: Any) => add(im));
    return { items: items.slice(0, 60) };
  }
  if (type === 'videos') return { items: res.map((x: Any) => ({ t: str(x.title, 200), u: link(x.url), s: tidy(x.content, 160), src: hostOf(x.url), d: day10(x.published_date) })) };
  return { items: res.map((x: Any) => ({ t: str(x.title, 200), u: link(x.url), s: tidy(x.content), d: day10(x.published_date) })) };
}
const SRC: Record<string, (type: string, q: string, tbs: string, sites?: string[]) => Promise<Any>> = { exa, tavily };

/* ---------- 免费的：维基百科卡片、维基共享资源图片 ---------- */
function loose(a: Any, b: Any) {
  const n = (x: Any) => String(x || '').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
  const x = n(a), y = n(b); return !!x && !!y && (x.includes(y) || y.includes(x));
}
function clip(t: string, n = 280) {
  t = t.replace(/\s+/g, ' ').trim(); if (t.length <= n) return t;
  const cut = t.slice(0, n), i = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('. '), cut.lastIndexOf('！'), cut.lastIndexOf('？'));
  return i > n * 0.5 ? cut.slice(0, i + 1) : cut + '…';
}
const wikiHost = (q: string) => CJK.test(q) ? 'zh.wikipedia.org' : 'en.wikipedia.org';
const wikiLink = (host: string, title: string) => 'https://' + host.replace('.wikipedia', '.m.wikipedia') + '/wiki/' + encodeURIComponent(title.replace(/ /g, '_'));
async function wiki(q: string) {   // 百科卡片：维基百科的第一条（标题要和搜的词对得上，不然不显示）
  if (q.length > 60) return null;
  const host = wikiHost(q);
  const p = new URLSearchParams({ action: 'query', format: 'json', formatversion: '2', generator: 'search', gsrsearch: q, gsrlimit: '1', gsrnamespace: '0', prop: 'extracts|pageimages|info', exintro: '1', explaintext: '1', piprop: 'thumbnail', pithumbsize: '240', inprop: 'url|displaytitle', redirects: '1' });
  if (CJK.test(q)) p.set('variant', 'zh-cn');
  const j = await getJson('https://' + host + '/w/api.php?' + p, { 'Api-User-Agent': BOT_UA, 'Accept-Language': CJK.test(q) ? 'zh-CN' : 'en' }, 5000);
  const pg = j && j.query && j.query.pages && j.query.pages[0];
  if (!pg || pg.missing) return null;
  const title = strip(pg.displaytitle || pg.title);
  const ex = String(pg.extract || '').trim();
  if (ex.length < 20 || /may refer to|可以指|可能指|可指/.test(ex.slice(0, 80))) return null;
  if (!loose(title, q) && !loose(pg.title, q)) return null;
  return { t: title.slice(0, 120), s: clip(ex), img: link(pg.thumbnail && pg.thumbnail.source), u: wikiLink(host, pg.title), src: '维基百科' };
}
async function commons(q: string) {   // 维基共享资源的图片：免费、清晰、能标出处
  const p = new URLSearchParams({ action: 'query', format: 'json', formatversion: '2', generator: 'search', gsrsearch: q, gsrnamespace: '6', gsrlimit: '20', prop: 'imageinfo', iiprop: 'url|size|mime', iiurlwidth: '480' });
  const j = await getJson('https://commons.wikimedia.org/w/api.php?' + p, { 'Api-User-Agent': BOT_UA }, 6000);
  return ((j && j.query && j.query.pages) || []).map((pg: Any) => {
    const ii = pg.imageinfo && pg.imageinfo[0]; if (!ii || !/^image\//.test(ii.mime || '')) return null;
    return { t: strip(String(pg.title || '').replace(/^File:|\.\w+$/g, '')).slice(0, 120), img: link(ii.url), th: link(ii.thumburl) || link(ii.url), w: num(ii.width), h: num(ii.height), u: link(ii.descriptionurl), src: '维基共享资源' };
  }).filter(Boolean);
}

/* ---------- 深挖：几个大数据库，全部免费 ---------- */
async function wikiList(q: string) {   // 用“搜索 + 摘要”一次取回：摘要会转成简体（搜索自带的片段繁简混杂）
  const host = wikiHost(q);
  const p = new URLSearchParams({ action: 'query', format: 'json', formatversion: '2', generator: 'search', gsrsearch: q, gsrlimit: '6', gsrnamespace: '0', prop: 'extracts|info', exintro: '1', explaintext: '1', exchars: '160', exlimit: '6', inprop: 'url|displaytitle' });
  if (CJK.test(q)) p.set('variant', 'zh-cn');
  const j = await getJson('https://' + host + '/w/api.php?' + p, { 'Api-User-Agent': BOT_UA });
  return ((j && j.query && j.query.pages) || []).slice().sort((a: Any, b: Any) => (a.index || 0) - (b.index || 0))
    .map((x: Any) => ({ t: str(strip(x.displaytitle || x.title), 160), u: wikiLink(host, x.title), s: str(String(x.extract || '').replace(/\s+/g, ' '), 240), f: day10(x.touched) && '更新于 ' + day10(x.touched) }));
}
const MEDIA: Record<string, string> = { texts: '书 / 文档', movies: '视频', audio: '音频', image: '图片', software: '软件', web: '网页', data: '数据', collection: '合集', etree: '现场录音' };
async function archiveSearch(q: string) {
  const p = new URLSearchParams({ q, rows: '8', output: 'json' });
  ['identifier', 'title', 'description', 'mediatype', 'year', 'creator'].forEach(f => p.append('fl[]', f));
  const j = await getJson('https://archive.org/advancedsearch.php?' + p);
  const one = (v: Any) => Array.isArray(v) ? v[0] : v;
  return ((j && j.response && j.response.docs) || []).filter((d: Any) => d.identifier).map((d: Any) => ({
    t: str(strip(one(d.title)), 160) || d.identifier, u: 'https://archive.org/details/' + encodeURIComponent(d.identifier), s: str(clip(strip(one(d.description)), 200), 220),
    f: [MEDIA[d.mediatype] || d.mediatype, one(d.year), str(strip(one(d.creator)), 40)].filter(Boolean).join(' · '), img: 'https://archive.org/services/img/' + encodeURIComponent(d.identifier), ext: true
  }));
}
async function openalex(q: string) {
  const p = new URLSearchParams({ search: q, per_page: '8', select: 'id,display_name,publication_year,doi,primary_location,open_access,authorships,cited_by_count' });
  if (sec('OPENALEX_API_KEY')) p.set('api_key', sec('OPENALEX_API_KEY'));
  const j = await getJson('https://api.openalex.org/works?' + p);
  return ((j && j.results) || []).map((w: Any) => {
    const oa = w.open_access && link(w.open_access.oa_url), land = w.primary_location && link(w.primary_location.landing_page_url);
    const au = (w.authorships || []).slice(0, 3).map((a: Any) => a && a.author && a.author.display_name).filter(Boolean).join('、');
    return { t: str(strip(w.display_name), 200), u: oa || land || link(w.doi) || link(w.id), s: au ? str(au + ((w.authorships || []).length > 3 ? ' 等' : ''), 160) : undefined,
      f: [w.publication_year, typeof w.cited_by_count === 'number' ? '被引用 ' + w.cited_by_count + ' 次' : '', oa ? '可以免费看全文' : ''].filter(Boolean).join(' · '), ext: !!(oa && /\.pdf($|\?)/i.test(oa)) };
  }).filter((x: Any) => x.t && x.u);
}
async function github(q: string) {
  const h: Record<string, string> = { Accept: 'application/vnd.github+json' };
  if (sec('GITHUB_TOKEN')) h.Authorization = 'Bearer ' + sec('GITHUB_TOKEN');
  const j = await getJson('https://api.github.com/search/repositories?' + new URLSearchParams({ q, per_page: '6' }), h);
  return ((j && j.items) || []).map((x: Any) => ({ t: str(x.full_name, 120), u: link(x.html_url), s: str(x.description, 240), f: ['★ ' + (x.stargazers_count || 0), x.language, day10(x.pushed_at) && '更新于 ' + day10(x.pushed_at)].filter(Boolean).join(' · ') })).filter((x: Any) => x.u);
}
async function hackernews(q: string) {
  const j = await getJson('https://hn.algolia.com/api/v1/search?' + new URLSearchParams({ query: q, tags: 'story', hitsPerPage: '6' }));
  return ((j && j.hits) || []).map((x: Any) => {
    const c = 'https://news.ycombinator.com/item?id=' + encodeURIComponent(x.objectID);
    return { t: str(x.title, 200), u: link(x.url) || c, c, f: [(x.points || 0) + ' 分', (x.num_comments || 0) + ' 条评论', day10(x.created_at)].filter(Boolean).join(' · ') };
  }).filter((x: Any) => x.t);
}
const DEEP: [string, string, (q: string) => Promise<Any[]>][] = [['wiki', '维基百科', wikiList], ['archive', '互联网档案馆', archiveSearch], ['papers', '论文', openalex], ['github', 'GitHub', github], ['hn', 'Hacker News 讨论', hackernews]];
async function doDeep(uid: string, q: string, c: Any) {
  const key = 'd' + await sha(q.toLowerCase());
  const hit = await cget(key);
  if (hit) return json({ ok: true, cached: true, ...hit });
  if (await bump(uid, 'd', c.deep_per_user_day) < 0) return fail('limit', '今天“深挖”用得太多了，明天再来');
  const got = await Promise.all(DEEP.map(d => d[2](q).then(items => items, () => null)));
  const groups = DEEP.map((d, i) => ({ k: d[0], n: d[1], items: got[i] || [] })).filter(g => g.items.length);
  const down = DEEP.filter((_, i) => got[i] === null).map(d => d[1]);
  const out = { type: 'deep', q, groups, down };
  if (down.length < DEEP.length) bg(cput(key, out));   // 全都没连上就不存，下次重试
  return json({ ok: true, cached: false, ...out });
}

/* ---------- 搜索入口 ---------- */
const TYPES = ['web', 'images', 'videos', 'news', 'deep'];
async function doSearch(uid: string, b: Any, c: Any) {
  const type = TYPES.includes(b.type) ? b.type : 'web';
  const q = String(b.q || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!q) return fail('bad', '没有要搜的内容');
  const sites: string[] = [];   // 搜索词里的“site:网址”拆出来，交给各家的“只搜这些网站”参数
  const words = q.replace(/(^|\s)site:(\S+)/gi, (_m: string, sp: string, d: string) => { const x = d.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, ''); if (/^[a-z0-9.-]+\.[a-z0-9-]{2,}(\/\S*)?$/.test(x) && sites.length < 5) sites.push(x); return sp; }).replace(/\s+/g, ' ').trim();
  if (!words) return fail('bad', '“site:”后面还要写上要搜的词');
  if (type === 'deep') return await doDeep(uid, words, c);
  const tbs = SINCE[b.tbs] ? b.tbs : '';
  const base = (type === 'images' ? c.img_order : c.order) || ['exa', 'tavily'];
  let want: string[] = SRC[b.src] ? [b.src] : base.filter((s: string) => SRC[s]);
  if (!SRC[b.src] && SRC[b.pref] && type !== 'images') want = [b.pref].concat(want.filter(s => s !== b.pref));   // 你在规则里选了先用哪家
  const ck: Record<string, string> = {};
  for (const s of want) ck[s] = 's' + await sha([type, q.toLowerCase(), tbs, s].join('|'));
  const got = await cgetMany(want.map(s => ck[s]).concat(want.map(s => 'x-' + s)));
  for (const s of want) { const x = got[ck[s]]; if (x && Date.now() - x.at <= TTL) return json({ ok: true, cached: true, ...x.v }); }
  const why: Record<string, string> = {}, avail: string[] = [];
  for (const s of want) {
    if (!KEY[s]()) { why[s] = 'nokey'; continue; }
    const m = got['x-' + s]; if (m && Date.now() - m.at < 6 * 3600000) { why[s] = 'empty'; continue; }   // 刚发现用完了：6 小时内不再去试
    avail.push(s);
  }
  if (!avail.length) {
    if (type === 'images' && !sites.length) { const cm = await commons(words).catch(() => []); if (cm.length) return json({ ok: true, cached: false, type, q, src: 'commons', items: cm, partial: true }); }
    return failAll(want, why);
  }
  const n = await bump(uid, 's', c.per_user_day);
  if (n < 0) return fail('limit', '今天搜了 ' + c.per_user_day + ' 次，到上限了，明天再来（搜过的词再搜不算次数）');
  const wikiP = type === 'web' && !sites.length ? wiki(words).catch(() => null) : Promise.resolve(null);
  const comP = type === 'images' && !sites.length ? commons(words).catch(() => []) : Promise.resolve([]);
  for (const s of avail) {
    let out: Any;
    try { out = await SRC[s](type, words, tbs, sites); }
    catch (e) {
      why[s] = e instanceof Oops ? e.code : 'upstream';
      if (why[s] === 'empty') bg(cput('x-' + s, { at: Date.now() }));
      continue;
    }
    if (type === 'images') { const seen = new Set(out.items.map((x: Any) => x.img)); out.items = out.items.concat((await comP).filter((x: Any) => !seen.has(x.img))); }
    if (type === 'web') { const w = await wikiP; if (w) out.wiki = w; }
    out.type = type; out.q = q; out.src = s;
    const used = await bump(ALL, 'm:' + s, 1000000000, true).catch(() => null);
    bg(cput(ck[s], out));
    return json({ ok: true, cached: false, left: c.per_user_day >= 100000 ? undefined : Math.max(0, c.per_user_day - n), used, ...out });   // 不限次数时不报“还剩几次”
  }
  if (type === 'images') { const cm = await comP; if (cm.length) return json({ ok: true, cached: false, type, q, src: 'commons', items: cm, partial: true }); }
  return failAll(want, why);
}
function failAll(list: string[], why: Record<string, string>) {
  const codes = list.map(s => why[s]);
  const named = (code: string) => list.filter(s => why[s] === code).map(s => NAME[s]).join('、');
  if (codes.every(x => x === 'nokey')) return fail('nokey', '搜索还没开通：服务器里还没填' + (list.length > 1 ? ' Exa 或 Tavily ' : ' ' + NAME[list[0]] + ' ') + '的密钥');
  if (codes.includes('badkey')) return fail('nokey', named('badkey') + ' 的密钥不对：检查服务器里填的密钥');
  if (codes.every(x => x === 'empty' || x === 'nokey')) return fail('empty', named('empty') + ' 这个月的免费次数用完了，下个月 1 号恢复；“深挖”还能用');
  if (codes.includes('busy')) return fail('busy', '搜得太快了，等几秒再试');
  return fail('upstream', '搜索服务暂时没响应，稍后再试');
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
async function grab(u0: URL, ms = 9000) {
  let cur = u0;
  for (let hop = 0; hop < 6; hop++) {
    let r: Response;
    try { r = await tfetch(cur.href, { redirect: 'manual', headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5', 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' } }, ms); }
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
function clean(content: string, base: string, imgUrl: (u: string) => string) {   // 只留白名单里的标签；属性只留链接和图片地址
  const { document } = parseHTML('<!doctype html><html><body><div id="chx">' + content + '</div></body></html>') as Any;
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
        out.push('<img src="' + escA(imgUrl(src)) + '"' + (alt ? ' alt="' + escA(alt) + '"' : '') + '>'); continue;
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
// 存档页里的地址要按原网址补全，图片改成从互联网档案馆取（原网站可能早没了）
function extract(html: string, base: string, arch?: string) {
  const { document } = parseHTML(html) as Any;
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
  const imgUrl = (u: string) => arch && !/^https?:\/\/web\.archive\.org\//.test(u) ? 'https://web.archive.org/web/' + arch + 'im_/' + u : u;
  const c = clean(r.content, base, imgUrl);
  if (c.text < 100) return null;
  const lead = abs(ogImg, base);
  return { u: base, title: str(r.title, 200) || hostOf(base), site: str(r.siteName, 60) || str(site, 60) || hostOf(base), by: str(r.byline, 80), date: day10(r.publishedTime || pub), lang: str(r.lang || lang, 20), html: c.html, len: c.text, img: c.imgs || !lead ? undefined : imgUrl(lead), arch };
}
async function doRead(uid: string, b: Any, c: Any) {
  const u0 = safeUrl(b.url); if (!u0) return fail('bad', '这个网址不能打开');
  let at = String(b.at || '');
  if (at && at !== 'latest' && !/^\d{4,14}$/.test(at)) return fail('bad', '存档时间不对');
  const key = 'r' + await sha(u0.href + '|' + at);
  const hit = await cget(key);
  if (hit) return json({ ok: true, cached: true, ...hit });
  if (await bump(uid, 'r', c.read_per_user_day) < 0) return fail('limit', '今天简洁阅读打开太多次了，明天再来；可以先点“原网页”');
  let target = u0;
  if (at) {
    if (at === 'latest') {
      let j: Any = null;
      try { j = await getJson('https://archive.org/wayback/available?' + new URLSearchParams({ url: u0.href }), {}, 9000); } catch { throw new Oops('fetch', '互联网档案馆暂时连不上，稍后再试'); }
      const cl = j && j.archived_snapshots && j.archived_snapshots.closest;
      if (!cl || !cl.available || !/^\d{14}$/.test(String(cl.timestamp))) return fail('noArchive', '互联网档案馆里没有这个网页的存档');
      at = String(cl.timestamp);
    }
    target = new URL('https://web.archive.org/web/' + at + 'id_/' + u0.href);
  }
  const got = await grab(target, at ? 15000 : 9000);
  if (at) { const m = /\/web\/(\d{14})id_\//.exec(got.url); if (m) at = m[1]; }   // 实际取到的是哪一天的存档
  const art = extract(got.html, at ? u0.href : got.url, at || undefined);
  if (!art) return fail('noArticle', at ? '这一版存档不是文章，没法简洁阅读' : '这个网页不是文章，没法简洁阅读');
  bg(cput(key, art));
  return json({ ok: true, cached: false, ...art });
}
async function doVersions(uid: string, b: Any, c: Any) {
  const u0 = safeUrl(b.url); if (!u0) return fail('bad', '这个网址不能打开');
  const key = 'v' + await sha(u0.href);
  const hit = await cget(key);
  if (hit) return json({ ok: true, cached: true, ...hit });
  if (await bump(uid, 'd', c.deep_per_user_day) < 0) return fail('limit', '今天查存档太多次了，明天再来');
  let rows: Any;
  try { rows = await getJson('https://web.archive.org/cdx/search/cdx?' + new URLSearchParams({ url: u0.href, output: 'json', fl: 'timestamp,statuscode', filter: 'statuscode:200', collapse: 'timestamp:6' }), {}, 15000); }
  catch { return fail('fetch', '互联网档案馆暂时连不上，稍后再试'); }
  const list = (Array.isArray(rows) ? rows.slice(1) : []).map((r: Any) => String(r && r[0])).filter((t: string) => /^\d{14}$/.test(t)).reverse().slice(0, 80);
  const out = { url: u0.href, list };
  bg(cput(key, out));
  return json({ ok: true, cached: false, ...out });
}

/* ---------- 入口 ---------- */
export async function handle(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return fail('bad', '只接受 POST', 405);
  let b: Any; try { b = await req.json(); } catch { return fail('bad', '请求格式不对', 400); }
  if (!b || typeof b !== 'object') return fail('bad', '请求格式不对', 400);
  await loadKeys();
  if (b.op === 'ping') return json({ ok: true, v: VER, keys: { exa: !!KEY.exa(), tavily: !!KEY.tavily(), openalex: !!sec('OPENALEX_API_KEY') } });
  let uid: string | null = null; try { uid = await uidOf(req); } catch { uid = null; }
  if (!uid) return fail('auth', '登录过期了，重新登录一下', 401);
  try {
    const c = await cfg();
    if (c.enabled === false) return fail('off', '搜索暂时关闭了');
    if (b.op === 'search') return await doSearch(uid, b, c);
    if (b.op === 'read') return await doRead(uid, b, c);
    if (b.op === 'versions') return await doVersions(uid, b, c);
    if (b.op === 'usage') return json({ ok: true, used: await usage(), free: { exa: c.exa_free, tavily: c.tavily_free }, keys: { exa: !!KEY.exa(), tavily: !!KEY.tavily() } });
    return fail('bad', '不认识的操作');
  } catch (e) {
    if (e instanceof Oops) return fail(e.code, e.message);
    console.error('chatter-search', e);
    return fail('server', '服务器出错了：' + String((e as Any)?.message || e).slice(0, 120));
  }
}
export const __test = { reset() { CFG = null; CFG_AT = 0; UIDS.clear(); DBK = {}; DBK_AT = 0; } };
if (!env('CHATTER_TEST')) Deno.serve(handle);
