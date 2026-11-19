/* Chatter 搜索：搜索首页、结果页（网页 / 图片 / 视频 / 新闻 / 深挖）、简洁阅读（含存档和历史版本）、搜索规则。
   点顶部的放大镜才下载这个文件，不用搜索的人不多花流量。
   颜色、字体全部用 App 的主题变量（--bg、--accent、--font……），跟着“我”里的主题和字体设置走。
   搜索结果由服务器函数 chatter-search 返回（Exa、Tavily 和几个免费数据库）；排序和过滤在手机上按你的规则做，改规则不花搜索次数。 */
(function () {
'use strict';
if (window.ChatterSearch) return;
const B = window.__chWS;
if (!B) return;

/* ---------- 小工具 ---------- */
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const LSg = (k, d) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } };
const LSs = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };
const uidKey = k => k + ':' + (B.uid() || '');
const host = u => { try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ''); } catch (e) { return ''; } };
const ico = (d, w) => '<svg viewBox="0 0 24 24" width="' + (w || 22) + '" height="' + (w || 22) + '" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + d + '</svg>';
const I = {
  back: '<path d="M15 5l-7 7 7 7"/>',
  find: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
  rules: '<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2.2"/><circle cx="10" cy="17" r="2.2"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  more: '<circle cx="5.5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="18.5" cy="12" r="1.3"/>',
  check: '<path d="M5 12l5 5 9-10"/>',
  down: '<path d="M6 9l6 6 6-6"/>',
  chev: '<path d="M9 6l6 6-6 6"/>',
  out: '<path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  size: '<path d="M4 19l5-14 5 14M6 14h6"/><path d="M15 19l3-8 3 8M16 16.5h4"/>',
  mark: '<path d="M6 4h12v17l-6-4-6 4z"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  send: '<path d="M21 3L10 14"/><path d="M21 3l-7 18-4-7-7-4z"/>',
  play: '<path d="M8 5.5v13l11-6.5z"/>',
  img: '<rect x="3.5" y="4.5" width="17" height="15" rx="3"/><circle cx="9" cy="10" r="1.8"/><path d="M20 16l-5-5-8 8.5"/>'
};
const TYPES = [['web', '网页'], ['images', '图片'], ['videos', '视频'], ['news', '新闻'], ['deep', '深挖']];
const TBS = [['', '时间不限'], ['day', '一天内'], ['week', '一周内'], ['month', '一个月内'], ['year', '一年内']];
const SIZES = [16, 18, 20, 22];
const MONO = ['var(--accent)', 'var(--ok)', 'var(--accent2)', '#e39a2d', '#3a8ee6'];
const monoColor = h => { let n = 0; for (let i = 0; i < h.length; i++) n = (n * 31 + h.charCodeAt(i)) >>> 0; return MONO[n % MONO.length]; };
const monoChar = h => { const s = h.replace(/^(m|mobile|zh|en|news|blog)\./, ''); return (s[0] || '?').toUpperCase(); };

/* ---------- 名单（数据库 app_config 里的 'search'；读不到用下面的） ---------- */
const CFG = {
  farms: ['baijiahao.baidu.com', 'mbd.baidu.com', 'jingyan.baidu.com', 'zhidao.baidu.com', 'wenku.baidu.com', 'toutiao.com', 'sohu.com/a/', '163.com/dy/', '360doc.com', 'docin.com', 'doc88.com', 'book118.com'],
  clean: ['wikipedia.org', 'github.com', 'stackoverflow.com', 'stackexchange.com', 'developer.mozilla.org', 'arxiv.org', 'britannica.com', 'nature.com', '.gov', '.edu', '.gov.cn', '.edu.cn'],
  direct: ['x.com', 'twitter.com', 'facebook.com', 'instagram.com', 'linkedin.com', 'reddit.com', 'pinterest.com', 'quora.com', 'tiktok.com', 'weibo.com', 'weibo.cn', 'xiaohongshu.com', 'douyin.com', 'zhihu.com'],
  // 知名网站：输入的网址和它们只差几个字母时，提醒可能是仿冒的（例如 blilblil.com 不是 B 站）
  popular: [['bilibili.com', '哔哩哔哩'], ['baidu.com', '百度'], ['qq.com', '腾讯'], ['taobao.com', '淘宝'], ['tmall.com', '天猫'], ['jd.com', '京东'], ['zhihu.com', '知乎'], ['weibo.com', '微博'], ['douyin.com', '抖音'],
    ['xiaohongshu.com', '小红书'], ['163.com', '网易'], ['sina.com.cn', '新浪'], ['sohu.com', '搜狐'], ['douban.com', '豆瓣'], ['csdn.net', 'CSDN'], ['iqiyi.com', '爱奇艺'], ['youku.com', '优酷'], ['pinduoduo.com', '拼多多'],
    ['meituan.com', '美团'], ['ctrip.com', '携程'], ['alipay.com', '支付宝'], ['12306.cn', '12306'], ['github.com', 'GitHub'], ['google.com', 'Google'], ['youtube.com', 'YouTube'], ['youtu.be', 'YouTube'],
    ['wikipedia.org', '维基百科'], ['twitter.com', 'Twitter'], ['x.com', 'X'], ['facebook.com', 'Facebook'], ['instagram.com', 'Instagram'], ['reddit.com', 'Reddit'], ['amazon.com', '亚马逊'], ['apple.com', '苹果'],
    ['icloud.com', 'iCloud'], ['microsoft.com', '微软'], ['outlook.com', 'Outlook'], ['openai.com', 'OpenAI'], ['chatgpt.com', 'ChatGPT'], ['claude.ai', 'Claude'], ['netflix.com', 'Netflix'], ['tiktok.com', 'TikTok'],
    ['telegram.org', 'Telegram'], ['whatsapp.com', 'WhatsApp'], ['paypal.com', 'PayPal'], ['steampowered.com', 'Steam'], ['stackoverflow.com', 'Stack Overflow'], ['medium.com', 'Medium'], ['pixiv.net', 'pixiv'],
    ['acfun.cn', 'AcFun'], ['hupu.com', '虎扑'], ['ithome.com', 'IT之家'], ['sspai.com', '少数派'], ['v2ex.com', 'V2EX'], ['nytimes.com', '纽约时报'], ['bbc.com', 'BBC'], ['supabase.com', 'Supabase']]
};
let cfgAt = 0;
function applyCfg(v) {
  if (!v || typeof v !== 'object') return;
  ['farms', 'clean', 'direct'].forEach(k => { if (Array.isArray(v[k])) CFG[k] = v[k].map(String); });
  if (Array.isArray(v.popular)) { const p = v.popular.filter(x => Array.isArray(x) && x[0]).map(x => [String(x[0]).toLowerCase(), String(x[1] || x[0])]); if (p.length) CFG.popular = p; }
}
// 网址的主名字：blilblil.com → blilblil，sina.com.cn → sina，zh.wikipedia.org → wikipedia
const mainLabel = h => { const p = String(h || '').replace(/^(www|m|wap|mobile)\./, '').split('.'); return p.length > 2 && /^(com|net|org|gov|edu|co|ac)$/.test(p[p.length - 2]) ? p[p.length - 3] : p.length >= 2 ? p[p.length - 2] : p[0]; };
function osa(a, b) {   // 两个词差几个字母（调换相邻两个字母算 1 次）
  if (Math.abs(a.length - b.length) > 4) return 99;
  const d = []; for (let i = 0; i <= a.length; i++) { d[i] = [i]; for (let j = 1; j <= b.length; j++) d[i][j] = i ? 0 : j; }
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
  }
  return d[a.length][b.length];
}
function lookAlike(u) {   // 和知名网站只差几个字母、本身又不是那个网站：可能是仿冒的
  const h = host(u); if (!h) return null;
  const pop = CFG.popular || [];
  if (pop.some(p => h === p[0] || h.endsWith('.' + p[0]))) return null;
  const lab = mainLabel(h); if (lab.length < 4) return null;
  let best = null, bd = 99;
  pop.forEach(p => { const pl = mainLabel(p[0]); if (pl.length < 4 || pl === lab) return; const d = osa(lab, pl); if (d < bd) { bd = d; best = p; } });   // 名字一样只是后缀不同（apple.com.cn）多半是正规的地区网站，不提醒
  if (!best) return null;
  const pl = mainLabel(best[0]), set = s => Array.from(new Set(s)).sort().join('');
  const near = (bd === 1 && pl.length >= 5) || (bd === 2 && pl.length >= 8) || (bd <= Math.floor(pl.length / 2) && lab[0] === pl[0] && set(lab) === set(pl) && Math.abs(lab.length - pl.length) <= 1);
  return near ? { d: best[0], n: best[1] } : null;
}
const bare = h => String(h || '').replace(/^(www|m|wap|mobile)\./, '');
function jumped(from, to) {   // 跳到了另一个网站（同一个网站换子域名、加 www 不算）
  const a = bare(host(from)), b = bare(host(to));
  return !!(a && b && a !== b && !a.endsWith('.' + b) && !b.endsWith('.' + a)) ? b : '';
}
async function loadCfg() {
  if (cfgAt && Date.now() - cfgAt < 600000) return;
  cfgAt = Date.now(); applyCfg(LSg('ch2wsCfg', null));
  try {
    const r = await B.sb().from('app_config').select('value').eq('key', 'search').maybeSingle();
    if (r && r.data && r.data.value) { applyCfg(r.data.value); LSs('ch2wsCfg', r.data.value); }
  } catch (e) {}
}
// 规则：'github.com' 匹配它和它的子域名；'.gov' 匹配所有 .gov 结尾的；'sohu.com/a/' 还要求路径开头对得上
function hit(u, list) {
  let h = '', p = '';
  try { const x = new URL(u); h = x.hostname.toLowerCase().replace(/^www\./, ''); p = x.pathname; } catch (e) { return false; }
  return (list || []).some(r => {
    r = String(r || '').toLowerCase().trim().replace(/^https?:\/\//, '').replace(/^www\./, '');
    if (!r) return false;
    const i = r.indexOf('/'), rh = i > 0 ? r.slice(0, i) : r, rp = i > 0 ? r.slice(i) : '';
    const hm = rh[0] === '.' ? h.endsWith(rh) : (h === rh || h.endsWith('.' + rh));
    return hm && (!rp || p.indexOf(rp) === 0);
  });
}
const normSite = s => { s = String(s || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, ''); return /^[a-z0-9.-]+\.[a-z0-9-]{2,}(\/\S*)?$/.test(s) ? s : ''; };

/* ---------- 规则（存在账号里，换手机也在；本机也存一份，打开就有） ---------- */
const prefsDef = () => ({ clean: true, hideFarms: true, src: '', pin: [], block: [], fav: [], autoTr: true });
let P = null, saveT = 0;
function loadPrefs() {
  const uid = B.uid() || '';
  if (P && P._uid === uid) return;
  P = Object.assign(prefsDef(), LSg('ch2ws:' + uid, {})); P._uid = uid;
  syncPrefs();
}
async function syncPrefs() {
  const prefs = P;
  try {
    const r = await B.sb().from('search_prefs').select('prefs, updated_at').maybeSingle();
    if (P !== prefs || B.uid() !== prefs._uid) return;
    const d = r && r.data;
    if (d && d.prefs && (Date.parse(d.updated_at) || 0) > (P._at || 0)) {
      P = Object.assign(prefsDef(), d.prefs, { _uid: P._uid, _at: Date.parse(d.updated_at) || 0 });
      LSs('ch2ws:' + P._uid, P); renderTop();
    }
  } catch (e) {}
}
function savePrefs() {
  P._at = Date.now(); LSs('ch2ws:' + P._uid, P);
  clearTimeout(saveT);
  const prefs = P;
  saveT = setTimeout(async () => {
    if (P !== prefs || B.uid() !== prefs._uid) return;
    const body = Object.assign({}, prefs); delete body._uid; delete body._at;
    try {
      const r = await B.sb().from('search_prefs').upsert({ uid: prefs._uid, prefs: body, updated_at: new Date().toISOString() }, { onConflict: 'uid' });
      if (r && r.error) B.logErr('ws-prefs', r.error);
    } catch (e) { B.logErr('ws-prefs', e); }
  }, 800);
}
function hist() { return LSg(uidKey('ch2wsHist'), []); }
function addHist(q) { LSs(uidKey('ch2wsHist'), [q].concat(hist().filter(x => x !== q)).slice(0, 30)); }

/* ---------- 样式 ---------- */
const CSS = `
.ws{position:fixed;inset:0;z-index:60;display:none;background:var(--bg);color:var(--ink);font-family:var(--font)}
.ws.on{display:block}
.ws-v{position:absolute;inset:0;display:none;flex-direction:column;background:var(--bg)}
.ws-v.on{display:flex;animation:fadein .16s ease}
.ws-in{width:100%;max-width:760px;margin:0 auto}
.ws-bar{display:flex;align-items:center;gap:6px;padding:10px 12px 8px;padding-top:calc(10px + env(safe-area-inset-top));flex-shrink:0}
.ws-ib{width:44px;height:44px;border-radius:14px;padding:0;background:transparent;color:var(--ink);display:flex;align-items:center;justify-content:center;flex-shrink:0}
.ws-field{flex:1;min-width:0;display:flex;align-items:center;gap:10px;height:46px;padding:0 6px 0 14px;background:var(--surface);border-radius:16px;box-shadow:var(--shadow);margin:0}
.ws-field>svg{color:var(--accent);flex-shrink:0}
.ws-field input{flex:1;min-width:0;border:0;padding:0;height:44px;background:transparent;box-shadow:none;border-radius:0;font-size:16px;color:var(--ink)}
.ws-field input:focus{box-shadow:none;border:0}
.ws-field input::-webkit-search-cancel-button{display:none}
.ws-clr{width:34px;height:34px;border-radius:12px;padding:0;background:transparent;color:var(--muted);display:none;align-items:center;justify-content:center;flex-shrink:0}
.ws-field.has .ws-clr{display:flex}
.ws-sc{flex:1;min-height:0;overflow-y:auto;-webkit-overflow-scrolling:touch;overscroll-behavior:contain}
.ws-pad{padding:0 16px calc(28px + env(safe-area-inset-bottom))}
.ws-chips{display:flex;gap:8px;padding:6px 16px 0;overflow-x:auto;scrollbar-width:none}
.ws-chips::-webkit-scrollbar{display:none}
.ws-chip{height:34px;padding:0 14px;border-radius:17px;background:var(--surface);box-shadow:var(--shadow);font-size:14px;color:var(--ink);display:inline-flex;align-items:center;gap:5px;flex-shrink:0;white-space:nowrap}
.ws-chip.act{background:var(--accent);color:#fff;box-shadow:none}
.ws-chip.soft{background:color-mix(in srgb,var(--accent) 13%,transparent);color:var(--accent);box-shadow:none;height:30px;font-size:13px;padding:0 12px}
.ws-chip.off{background:var(--surface2);color:var(--muted)}
.ws-sec{display:flex;align-items:center;justify-content:space-between;font-size:13px;color:var(--muted);margin:24px 4px 8px}
.ws-sec button{background:transparent;padding:4px 2px;font-size:13px;color:var(--muted)}
.ws-card{background:var(--surface);border-radius:20px;box-shadow:var(--shadow);overflow:hidden}
.ws-row{display:flex;align-items:center;gap:12px;padding:8px 8px 8px 14px;min-height:52px;font-size:15px;width:100%;background:transparent;border-radius:0;text-align:left;color:var(--ink)}
.ws-row+.ws-row{border-top:1px solid var(--line)}
.ws-row>svg{color:var(--muted);flex-shrink:0}
.ws-row .ws-tx{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ws-row .ws-sub{display:block;font-size:12.5px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:2px}
.ws-row .ws-x{width:36px;height:36px;padding:0;border-radius:12px;background:transparent;color:var(--muted);display:flex;align-items:center;justify-content:center;flex-shrink:0}
.ws-grid{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:12px 6px}
.ws-tile{display:flex;flex-direction:column;align-items:center;gap:7px;background:transparent;padding:0;color:var(--ink);min-width:0}
.ws-tile .ws-mono{width:54px;height:54px;border-radius:17px;background:var(--surface);box-shadow:var(--shadow);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:19px}
.ws-tile .ws-mono.add{background:transparent;box-shadow:none;border:1.5px dashed var(--muted);color:var(--muted)}
.ws-tile span:last-child{font-size:12px;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ws-hint{font-size:12.5px;color:var(--muted);margin:10px 4px 0;line-height:1.5}
.ws-tabs{display:flex;gap:2px;padding:0 12px;border-bottom:1px solid var(--line);flex-shrink:0}
.ws-tab{height:42px;padding:0 10px;font-size:15px;color:var(--muted);background:transparent;border-radius:0;flex-shrink:0}
.ws-srcb{margin-left:auto;align-self:center;height:30px;padding:0 6px 0 10px;border-radius:15px;background:var(--surface2);color:var(--muted);font-size:12.5px;display:flex;align-items:center;gap:2px;flex-shrink:0;white-space:nowrap}
.ws-tab.on{color:var(--accent);font-weight:700;box-shadow:inset 0 -3px 0 var(--accent)}
.ws-list{padding:6px 12px calc(28px + env(safe-area-inset-bottom));display:flex;flex-direction:column;gap:10px}
.ws-r{padding:14px 12px 14px 16px;display:flex;flex-direction:column;gap:5px;cursor:pointer;position:relative}
.ws-r+.ws-r{border-top:1px solid var(--line)}
.ws-rt{display:flex;align-items:center;gap:8px;font-size:12.5px;color:var(--muted);min-width:0}
.ws-rt .m{width:20px;height:20px;border-radius:6px;color:#fff;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0}
.ws-rt .h{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.ws-tag{height:22px;padding:0 8px;border-radius:11px;font-size:11.5px;display:inline-flex;align-items:center;flex-shrink:0;background:color-mix(in srgb,var(--accent) 13%,transparent);color:var(--accent)}
.ws-tag.g{background:color-mix(in srgb,var(--ok) 15%,transparent);color:var(--ok)}
.ws-more{margin-left:auto;width:32px;height:28px;padding:0;border-radius:10px;background:transparent;color:var(--muted);display:flex;align-items:center;justify-content:center;flex-shrink:0}
.ws-r a.t{font-size:16.5px;font-weight:600;color:var(--accent);line-height:1.4;text-decoration:none;word-break:break-word}
.ws-r .s{font-size:13.5px;color:var(--muted);line-height:1.55;word-break:break-word}
.ws-r .f{font-size:12px;color:var(--muted)}
.ws-r.nw{flex-direction:row;gap:12px}
.ws-r.nw .c{flex:1;min-width:0;display:flex;flex-direction:column;gap:5px}
.ws-r.nw img{width:84px;height:84px;border-radius:14px;object-fit:cover;background:var(--surface2);flex-shrink:0}
.ws-kg{padding:14px;display:flex;gap:12px}
.ws-kg img,.ws-kg .ph{width:70px;height:70px;border-radius:14px;object-fit:cover;background:var(--surface2);flex-shrink:0}
.ws-kg .c{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px}
.ws-kg b{font-size:17px}
.ws-kg .ty{font-size:12.5px;color:var(--muted)}
.ws-kg .s{font-size:13.5px;line-height:1.55;color:var(--ink);opacity:.86}
.ws-kg .src{font-size:12px;color:var(--muted)}
.ws-kg dl{margin:6px 0 0;display:grid;grid-template-columns:auto 1fr;gap:3px 10px;font-size:13px}
.ws-kg dt{color:var(--muted)}
.ws-kg dd{margin:0;word-break:break-word}
.ws-ans{padding:14px 16px;font-size:15px;line-height:1.6}
.ws-ans .src{display:block;font-size:12px;color:var(--muted);margin-top:6px}
.ws-btn{height:44px;border-radius:14px;background:var(--surface);box-shadow:var(--shadow);color:var(--ink);font-size:14.5px;width:100%}
.ws-btn.pri{background:var(--accent);color:#fff;box-shadow:none}
.ws-note{font-size:12.5px;color:var(--muted);text-align:center;padding:2px 0}
.ws-note button{background:transparent;padding:0 4px;color:var(--accent);font-size:12.5px}
.ws-rel{display:flex;flex-wrap:wrap;gap:8px}
.ws-err{padding:22px 18px;text-align:center;display:flex;flex-direction:column;gap:12px;align-items:center}
.ws-err p{margin:0;font-size:15px;line-height:1.6}
.ws-err small{color:var(--muted);font-size:12.5px;line-height:1.5}
.ws-err .ws-btn{max-width:240px}
.ws-sk{padding:16px}
.ws-sk i{display:block;height:13px;border-radius:7px;background:var(--surface2);margin:0 0 12px;animation:wsPulse 1.2s ease-in-out infinite}
@keyframes wsPulse{50%{opacity:.5}}
.ws-imgs{columns:2;column-gap:8px;padding:8px 12px calc(28px + env(safe-area-inset-bottom))}
@media (min-width:600px){.ws-imgs{columns:3}}
.ws-im{break-inside:avoid;margin:0 0 8px;border-radius:14px;overflow:hidden;background:var(--surface2);cursor:pointer;position:relative}
.ws-im img{display:block;width:100%;height:auto;min-height:60px;object-fit:cover}
.ws-im span{position:absolute;left:0;right:0;bottom:0;padding:16px 8px 6px;font-size:11px;color:#fff;background:linear-gradient(transparent,rgba(0,0,0,.55));overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ws-vd{display:flex;gap:12px;padding:12px;cursor:pointer}
.ws-vd+.ws-vd{border-top:1px solid var(--line)}
.ws-vd .th{width:132px;aspect-ratio:16/9;border-radius:12px;background:var(--surface2) center/cover no-repeat;position:relative;flex-shrink:0}
.ws-vd .th em{position:absolute;right:5px;bottom:5px;font-style:normal;font-size:11px;color:#fff;background:rgba(0,0,0,.66);padding:1px 6px;border-radius:6px}
.ws-vd .c{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px}
.ws-vd b{font-size:15px;font-weight:600;line-height:1.4;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.ws-vd .f{font-size:12px;color:var(--muted)}
.ws-site{flex:1;text-align:center;font-size:13px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ws-art{padding:12px 24px 40px;line-height:1.85;word-break:break-word}
.ws-art h1{font-size:1.4em;line-height:1.4;margin:6px 0 10px}
.ws-art .meta{font-size:13px;color:var(--muted);margin-bottom:18px;line-height:1.5}
.ws-body h2,.ws-body h3,.ws-body h4{line-height:1.45;margin:1.4em 0 .6em}
.ws-body h2{font-size:1.15em}.ws-body h3,.ws-body h4{font-size:1.05em}
.ws-body p{margin:0 0 1em}
.ws-body img{display:block;max-width:100%;height:auto;margin:14px auto;border-radius:12px;background:var(--surface2)}
.ws-body figure{margin:14px 0}
.ws-body figcaption{font-size:.8em;color:var(--muted);text-align:center;line-height:1.5}
.ws-body a{color:var(--accent);text-decoration:none}
.ws-body blockquote{margin:1em 0;padding:10px 14px;background:var(--surface2);border-radius:12px}
.ws-body pre{overflow-x:auto;background:var(--surface2);padding:12px;border-radius:12px;font-size:.82em;line-height:1.55}
.ws-body code{font-size:.9em}
.ws-body table{display:block;overflow-x:auto;border-collapse:collapse;font-size:.88em;margin:1em 0}
.ws-body th,.ws-body td{border:1px solid var(--line);padding:6px 9px;text-align:left;vertical-align:top}
.ws-body ul,.ws-body ol{padding-left:1.4em;margin:0 0 1em}
.ws-body hr{border:0;height:1px;background:var(--line);margin:1.6em 0}
.ws-lead{width:100%;border-radius:18px;margin:0 0 18px;display:block;background:var(--surface2)}
.ws-from{font-size:12.5px;color:var(--muted);margin-top:24px}
.ws-from a{color:var(--muted)}
.ws-tool{display:grid;grid-template-columns:repeat(5,1fr);padding:6px 8px calc(6px + env(safe-area-inset-bottom));background:var(--surface);border-top:1px solid var(--line);flex-shrink:0}
.ws-tool button{display:flex;flex-direction:column;align-items:center;gap:3px;font-size:11px;color:var(--ink);background:transparent;min-height:48px;justify-content:center;border-radius:12px;padding:4px}
.ws-tool button.on{color:var(--accent)}
.ws-v.dk{background:#0b0a10;color:#f1eefb}
.ws-v.dk .ws-ib{color:#f1eefb}
.ws-v.dk .ws-site{color:rgba(241,238,251,.7)}
.ws-big{flex:1;min-height:0;display:flex;align-items:center;justify-content:center;padding:8px}
.ws-big img{max-width:100%;max-height:100%;object-fit:contain;border-radius:6px}
.ws-big p{color:rgba(241,238,251,.7);font-size:14px}
.ws-dkb{display:flex;gap:10px;padding:10px 16px calc(12px + env(safe-area-inset-bottom))}
.ws-dkb button{flex:1;height:44px;border-radius:14px;background:rgba(255,255,255,.12);color:#f1eefb;font-size:14px}
.ws-dkt{padding:0 16px 6px;font-size:14px;line-height:1.5;color:rgba(241,238,251,.86)}
.ws-dkt small{display:block;color:rgba(241,238,251,.55);font-size:12px;margin-top:2px}
.ws-player{width:100%;aspect-ratio:16/9;background:#000;border:0;display:block}
.ws-sw{width:50px;height:30px;border-radius:15px;padding:0;background:var(--surface2);position:relative;flex-shrink:0;transition:background .15s}
.ws-sw::after{content:"";position:absolute;left:3px;top:3px;width:24px;height:24px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.25);transition:transform .15s}
.ws-sw[aria-checked="true"]{background:var(--accent)}
.ws-sw[aria-checked="true"]::after{transform:translateX(20px)}
.ws-val{color:var(--muted);font-size:14px;flex-shrink:0}
.ws-rules details{padding:0 14px}
.ws-rules summary{min-height:48px;display:flex;align-items:center;font-size:15px;cursor:pointer;list-style:none}
.ws-rules summary::-webkit-details-marker{display:none}
.ws-rules details p{margin:0 0 12px;font-size:13px;color:var(--muted);line-height:1.7;word-break:break-all}
.ws-rules details+details{border-top:1px solid var(--line)}
.ws-gh{display:flex;align-items:baseline;justify-content:space-between;padding:14px 16px 2px;font-size:14px}
.ws-gh span{font-size:12px;color:var(--muted)}
.ws-lnk{background:transparent;padding:0;font-size:12px;color:var(--accent);border-radius:0}
.ws-arch{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:4px 0 16px;padding:10px 12px;border-radius:14px;background:color-mix(in srgb,var(--accent) 11%,transparent);font-size:13px;line-height:1.5}
.ws-arch span{flex:1;min-width:150px}
.ws-arch button{height:30px;padding:0 10px;border-radius:10px;background:var(--surface);color:var(--accent);font-size:12.5px}
.ws-vd .th .pl{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:var(--muted)}
.ws-warn{display:flex;flex-direction:column;gap:8px;margin:4px 0 16px;padding:12px 14px;border-radius:14px;background:color-mix(in srgb,#e3502d 13%,transparent);font-size:13.5px;line-height:1.6;text-align:left}
.ws-warn b{color:#d4421f}
.ws-warn button{align-self:flex-start;height:32px;padding:0 12px;border-radius:10px;background:var(--surface);color:var(--accent);font-size:13px}
.ws-jump{margin:4px 0 14px;padding:10px 12px;border-radius:14px;background:var(--surface2);font-size:13px;line-height:1.55;color:var(--muted);text-align:left}
.ws-trb{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:4px 0 14px;padding:9px 10px 9px 12px;border-radius:14px;background:color-mix(in srgb,var(--ok) 13%,transparent);font-size:13px;line-height:1.5}
.ws-trb span{flex:1;min-width:140px}
.ws-trb button{height:30px;padding:0 11px;border-radius:10px;background:var(--surface);color:var(--accent);font-size:12.5px}
.ws-trb.err{background:var(--surface2)}
.ws-ot{font-size:13px;color:var(--muted);margin:-4px 0 10px;line-height:1.5}
.ws-desc{font-size:14px;color:var(--muted);line-height:1.65;margin:0 0 14px}
.ws-lks .ws-row{min-height:56px;cursor:pointer}
.ws-lks .ws-tx{white-space:normal;line-height:1.45}
.ws-qen{font-size:13px;color:var(--muted);padding:2px 4px 0;line-height:1.6}
.ws-qen button{background:transparent;padding:0 2px;color:var(--accent);font-size:13px}
`;

/* ---------- 界面骨架 ---------- */
let root = null, accountRevision = 0;
const W = { on: false, stack: [], type: 'web', tbs: '', cur: null, seq: 0, left: null, showFarms: false, fs: LSg('ch2wsFs', 18), shownRead: null, view: [], used: {}, free: { exa: 2500, tavily: 1000 }, keys: null, trc: new Map() };
if (SIZES.indexOf(W.fs) < 0) W.fs = 18;
function bar(id, ph, right) {
  return '<div class="ws-bar ws-in"><button type="button" class="ws-ib" data-act="back" aria-label="返回">' + ico(I.back) + '</button>' +
    '<form class="ws-field" data-form="' + id + '" action="#" role="search">' + ico(I.find, 18) +
    '<input type="search" enterkeyhint="search" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="' + esc(ph) + '" aria-label="' + esc(ph) + '">' +
    '<button type="button" class="ws-clr" data-act="clear" aria-label="清空">' + ico(I.x, 16) + '</button></form>' + (right || '') + '</div>';
}
const rulesBtn = '<button type="button" class="ws-ib" data-act="rules" aria-label="搜索规则">' + ico(I.rules) + '</button>';
function build() {
  if (root) return;
  if (!document.getElementById('ws-css')) {
    const st = document.createElement('style'); st.id = 'ws-css'; st.textContent = CSS; document.head.appendChild(st);
  }
  root = document.createElement('div'); root.id = 'ws'; root.className = 'ws'; root.setAttribute('role', 'dialog'); root.setAttribute('aria-label', '搜索');
  root.innerHTML =
    '<section class="ws-v" data-v="home">' + bar('home', '搜索，或者粘贴网址', rulesBtn) + '<div class="ws-chips ws-in" data-r="types"></div><div class="ws-sc"><div class="ws-pad ws-in" data-r="home"></div></div></section>' +
    '<section class="ws-v" data-v="res">' + bar('res', '搜索', rulesBtn) + '<div class="ws-tabs ws-in" data-r="tabs"></div><div class="ws-sc" data-r="rsc"><div class="ws-in"><div class="ws-chips" data-r="filters" style="padding:10px 12px 6px"></div><div data-r="res"></div></div></div></section>' +
    '<section class="ws-v" data-v="read"><div class="ws-bar ws-in"><button type="button" class="ws-ib" data-act="back" aria-label="返回">' + ico(I.back) + '</button><span class="ws-site" data-r="rsite"></span><button type="button" class="ws-chip" data-act="rd-orig" style="height:34px;font-size:13px;margin-right:6px">原网页</button></div><div class="ws-sc" data-r="rdsc"><div class="ws-in" data-r="read"></div></div>' +
      '<div class="ws-tool" data-r="rtool"><button type="button" data-act="rd-fs">' + ico(I.size) + '字号</button><button type="button" data-act="rd-fav">' + ico(I.mark) + '收藏</button><button type="button" data-act="rd-vers">' + ico(I.clock) + '历史版本</button><button type="button" data-act="rd-copy">' + ico(I.link) + '复制链接</button><button type="button" data-act="rd-send">' + ico(I.send) + '发给好友</button></div></section>' +
    '<section class="ws-v" data-v="rules"><div class="ws-bar ws-in"><button type="button" class="ws-ib" data-act="back" aria-label="返回">' + ico(I.back) + '</button><span class="ws-site" style="color:var(--ink);font-size:16px;font-weight:600">搜索规则</span><span style="width:50px"></span></div><div class="ws-sc"><div class="ws-pad ws-in ws-rules" data-r="rules"></div></div></section>' +
    '<section class="ws-v dk" data-v="img"><div class="ws-bar"><button type="button" class="ws-ib" data-act="back" aria-label="返回">' + ico(I.back) + '</button><span class="ws-site" data-r="isite"></span><span style="width:50px"></span></div><div class="ws-big" data-r="ibig"></div><div class="ws-dkt" data-r="itxt"></div><div class="ws-dkb"><button type="button" data-act="img-page">打开来源网页</button><button type="button" data-act="img-raw">用浏览器看原图</button></div></section>' +
    '<section class="ws-v dk" data-v="vid"><div class="ws-bar"><button type="button" class="ws-ib" data-act="back" aria-label="返回">' + ico(I.back) + '</button><span class="ws-site" data-r="vsite"></span><span style="width:50px"></span></div><div class="ws-big" style="align-items:flex-start;padding:0" data-r="vbox"></div><div class="ws-dkb"><button type="button" data-act="vid-out">在原网站打开</button><button type="button" data-act="vid-send">发给好友</button></div></section>';
  (document.querySelector('.app-container') || document.body).appendChild(root);
  root.addEventListener('click', onClick);
  root.addEventListener('submit', e => { e.preventDefault(); const f = e.target; const inp = f.querySelector('input'); try { inp.blur(); } catch (x) {} search(inp.value, W.type); });
  root.addEventListener('input', e => { const f = e.target.closest && e.target.closest('.ws-field'); if (f) f.classList.toggle('has', !!e.target.value); });
  root.querySelector('[data-r="read"]').addEventListener('error', e => {   // 文章里的图片取不到：直接去掉，不留破图
    const im = e.target; if (!im || im.tagName !== 'IMG') return;
    const fig = im.closest('figure'); im.remove(); if (fig && !fig.querySelector('img') && !fig.textContent.trim()) fig.remove();
  }, true);
  root.querySelector('[data-r="res"]').addEventListener('error', e => { const im = e.target; if (im && im.tagName === 'IMG') { const box = im.closest('.ws-im'); if (box) box.remove(); else im.style.visibility = 'hidden'; } }, true);
}
const R = k => root.querySelector('[data-r="' + k + '"]');
const V = v => root.querySelector('.ws-v[data-v="' + v + '"]');

/* ---------- 页面栈和返回手势：每进一层加一条浏览器历史，边缘滑 / 返回键 = 退一层 ---------- */
function top() { return W.stack[W.stack.length - 1]; }
function scroller(v) { return v === 'res' ? R('rsc') : v === 'read' ? R('rdsc') : (V(v) && V(v).querySelector('.ws-sc')); }
function show() {
  const t = top(); if (!t) return;
  root.querySelectorAll('.ws-v').forEach(el => el.classList.toggle('on', el.dataset.v === t.v));
  if (t.v === 'home') renderHome();
  else if (t.v === 'res') renderRes();
  else if (t.v === 'read') renderRead(t);
  else if (t.v === 'rules') renderRules();
  else if (t.v === 'img') renderImg(t);
  else if (t.v === 'vid') renderVid(t);
  if (t.v !== 'vid') { R('vbox').innerHTML = ''; R('vbox').dataset.src = ''; }   // 离开播放页就停掉视频
  const sc = scroller(t.v); if (sc && t.y != null) sc.scrollTop = t.y;   // 回到上一层时停在原来看到的位置
}
function go(v, d) {
  const cur = top(); if (cur) { const sc = scroller(cur.v); if (sc) cur.y = sc.scrollTop; }
  W.stack.push({ v: v, d: d || {} });
  try { history.pushState({ ws: W.stack.length }, '', location.href); } catch (e) {}
  show();
}
function back() {
  if (history.state && history.state.ws) { try { history.back(); return; } catch (e) {} }
  popTo(W.stack.length - 1);
}
function popTo(n) {
  W.stack.length = Math.max(0, Math.min(n, W.stack.length));
  if (!W.stack.length) { close(); return; }
  show();
}
function close() {
  W.on = false; W.stack.length = 0;
  if (root) { root.classList.remove('on'); R('vbox').innerHTML = ''; R('vbox').dataset.src = ''; }
  document.body.classList.remove('ws-open');
}
function resetAccount() {
  accountRevision++;
  clearTimeout(saveT); P = null;
  close();
  W.seq++; W.cur = null; W.shownRead = null; W.view = []; W.trc.clear();
  W.type = 'web'; W.tbs = ''; W.showFarms = false; W.left = null; W.used = {}; W.keys = null;
  if (root) { root.remove(); root = null; }
}
function onPop(e) {
  if (!W.on) return false;
  const st = (e && e.state) || history.state;
  popTo((st && st.ws) || 0);
  return true;
}
function open(q) {
  build(); loadPrefs(); loadCfg(); loadUsage();
  if (W.on) { if (q) search(q, W.type); return; }
  W.on = true; root.classList.add('on'); document.body.classList.add('ws-open');
  go('home');
  if (q) { search(q, W.type); return; }
  const inp = V('home').querySelector('input'); inp.value = ''; inp.closest('.ws-field').classList.remove('has');
  setTimeout(() => { try { inp.focus(); } catch (e) {} }, 30);
}
function renderTop() { if (W.on && top()) show(); }

/* ---------- 搜索首页 ---------- */
function renderHome() {
  R('types').innerHTML = TYPES.map(t => '<button type="button" class="ws-chip' + (W.type === t[0] ? ' act' : '') + '" data-act="type" data-t="' + t[0] + '">' + t[1] + '</button>').join('');
  let h = '<div class="ws-sec" style="margin-top:22px">置顶网站</div><div class="ws-grid">';
  (P.pin || []).slice(0, 14).forEach(d => {
    const hs = d.split('/')[0];
    h += '<button type="button" class="ws-tile" data-act="pin-go" data-d="' + esc(d) + '"><span class="ws-mono" style="color:' + monoColor(hs) + '">' + esc(monoChar(hs)) + '</span><span>' + esc(hs.replace(/\.(com|org|net|cn|io)$/, '')) + '</span></button>';
  });
  h += '<button type="button" class="ws-tile" data-act="pin-add"><span class="ws-mono add">' + ico(I.plus, 20) + '</span><span style="color:var(--muted)">添加</span></button></div>';
  if (!(P.pin || []).length) h += '<div class="ws-hint">置顶的网站排在结果最前面；点一下只搜这个网站。</div>';
  const fav = (P.fav || []).slice(0, 6);
  if (fav.length) {
    h += '<div class="ws-sec">收藏的文章' + ((P.fav || []).length > 6 ? '<button type="button" data-act="fav-all">全部 ' + P.fav.length + ' 篇</button>' : '') + '</div><div class="ws-card">';
    fav.forEach((f, i) => { h += '<div class="ws-row" data-act="fav-go" data-i="' + i + '">' + ico(I.mark, 17) + '<span class="ws-tx">' + esc(f.t || f.u) + '<span class="ws-sub">' + esc(f.s || host(f.u)) + '</span></span></div>'; });
    h += '</div>';
  }
  const sn = seen().slice(0, 5);
  if (sn.length) {
    h += '<div class="ws-sec">最近看过<button type="button" data-act="seen-clear">清空</button></div><div class="ws-card">';
    sn.forEach((x, i) => { h += '<div class="ws-row" data-act="seen-go" data-i="' + i + '" style="cursor:pointer">' + ico(I.chev, 15) + '<span class="ws-tx">' + esc(x.t || x.u) + '<span class="ws-sub">' + esc((x.s || host(x.u)) + (x.at ? ' · ' + tsDay(x.at) + ' 存档' : '')) + '</span></span></div>'; });
    h += '</div>';
  }
  const hs = hist().slice(0, 8);
  if (hs.length) {
    h += '<div class="ws-sec">最近搜过<button type="button" data-act="hist-clear">清空</button></div><div class="ws-card">';
    hs.forEach(q => { h += '<div class="ws-row" data-act="go-q" data-q="' + esc(q) + '">' + ico(I.clock, 17) + '<span class="ws-tx">' + esc(q) + '</span><button type="button" class="ws-x" data-act="hist-del" data-q="' + esc(q) + '" aria-label="删掉这条">' + ico(I.x, 15) + '</button></div>'; });
    h += '</div>';
  }
  R('home').innerHTML = h;
}

/* ---------- 搜索 ---------- */
const URLISH = /^(https?:\/\/\S+|[\w-]+(\.[\w-]+)*\.(com|cn|net|org|io|dev|app|gov|edu|me|co|info|tv|cc|xyz|top|jp|hk|tw|uk|de|fr|ru|kr|sg)(\/\S*)?)$/i;
const SRCN = { exa: 'Exa', tavily: 'Tavily', commons: '维基共享资源' };
function search(q, type, src, from) {
  q = String(q || '').replace(/\s+/g, ' ').trim(); if (!q) return;
  if (URLISH.test(q) && q.indexOf(' ') < 0) { openUrl(/^https?:/i.test(q) ? q : 'https://' + q); return; }
  W.type = type || W.type || 'web';
  addHist(from || q); W.showFarms = false;
  W.cur = { q: q, from: from || '', type: W.type, tbs: W.type === 'deep' ? '' : W.tbs, src: src || '', items: [], data: null, used: '', loading: false, err: null, done: false };
  const t = top();
  if (t && t.v === 'res') { t.y = 0; show(); } else go('res');
  const sc = R('rsc'); if (sc) sc.scrollTop = 0;
  fetchRes();
}
async function fetchRes() {
  const c = W.cur; if (!c || c.loading) return;
  c.loading = true; c.err = null; const my = ++W.seq;
  renderRes();
  const r = await B.call({ op: 'search', q: c.q, type: c.type, tbs: c.tbs || '', src: c.src || '', pref: P.src || '' }, c.type === 'deep' ? 25000 : 20000);
  if (my !== W.seq || W.cur !== c) return;
  c.loading = false;
  if (r && r.ok) {
    c.done = true; c.data = r; c.items = r.items || []; c.used = r.src || '';
    if (typeof r.left === 'number') W.left = r.left;
    if (r.src && typeof r.used === 'number') W.used[r.src] = r.used;
  } else c.err = r || { code: 'net', msg: '出错了' };
  renderRes();
  if (c.done && c.type !== 'images' && P.autoTr !== false && resForeign(c)) trRes(c);   // 外文结果：标题和摘要自动翻成中文
}
async function loadUsage() {
  const account = accountRevision;
  const r = await B.call({ op: 'usage' }, 10000);
  if (account !== accountRevision || !r || !r.ok) return;
  W.used = Object.assign({}, W.used, r.used || {}); W.free = Object.assign({}, W.free, r.free || {}); W.keys = r.keys || W.keys;
  const t = top(); if (W.on && t && t.v === 'rules') renderRules();
}
const usageText = s => W.used[s] != null ? '（本月用了 ' + W.used[s] + ' 次，免费约 ' + (W.free[s] || '?') + ' 次）' : '';
const otherSrc = s => s === 'tavily' ? 'exa' : 'tavily';
function arrange(items) {   // 按你的规则：不看的网站去掉，营销号去掉，置顶的排最前，干净的往前挪 3 位
  let farms = 0; const out = [];
  items.forEach((it, i) => {
    if (!it || !it.u) return;
    if (hit(it.u, P.block)) return;
    const farm = hit(it.u, CFG.farms);
    if (farm && P.hideFarms && !W.showFarms) { farms++; return; }
    const pin = hit(it.u, P.pin), clean = !!P.clean && hit(it.u, CFG.clean);
    out.push({ it: it, i: i, pin: pin, clean: clean, farm: farm, score: i - (pin ? 1000 : 0) - (clean ? 3 : 0) });
  });
  out.sort((a, b) => a.score - b.score || a.i - b.i);
  return { list: out, farms: farms };
}
function renderRes() {
  const c = W.cur; if (!c || !root) return;
  const v = V('res'), inp = v.querySelector('input');
  if (document.activeElement !== inp) { inp.value = c.q; inp.closest('.ws-field').classList.toggle('has', !!c.q); }
  const sn = SRCN[c.used || c.src || (c.type === 'images' ? 'tavily' : (P.src || 'exa'))];
  R('tabs').innerHTML = TYPES.map(t => '<button type="button" class="ws-tab' + (c.type === t[0] ? ' on' : '') + '" data-act="tab" data-t="' + t[0] + '">' + t[1] + '</button>').join('') +
    (c.type !== 'deep' ? '<button type="button" class="ws-srcb" data-act="src" aria-label="换一家搜">' + esc(sn) + ico(I.down, 13) + '</button>' : '');
  const tl = (TBS.find(x => x[0] === (c.tbs || '')) || TBS[0])[1];
  let f = '';
  if (c.type === 'web' || c.type === 'news') f += '<button type="button" class="ws-chip ' + (P.clean ? 'soft' : 'soft off') + '" data-act="tgl-clean">' + (P.clean ? ico(I.check, 13) : '') + '干净页面优先</button>' +
    '<button type="button" class="ws-chip ' + (P.hideFarms ? 'soft' : 'soft off') + '" data-act="tgl-farm">' + (P.hideFarms ? ico(I.check, 13) : '') + '不看营销号</button>';
  if (c.type !== 'deep') f += '<button type="button" class="ws-chip soft' + (c.tbs ? '' : ' off') + '" data-act="tbs">' + esc(tl) + ico(I.down, 13) + '</button>';
  if (c.done && c.type !== 'images' && (c.tr || resForeign(c))) f += '<button type="button" class="ws-chip ' + (c.trOn ? 'soft' : 'soft off') + '" data-act="res-tr">' + (c.tr === 'busy' ? '正在翻译…' : (c.trOn ? ico(I.check, 13) + '已翻成中文' : '翻译成中文')) + '</button>';
  R('filters').innerHTML = f; R('filters').style.display = f ? '' : 'none';
  const box = R('res'); let h = '';
  W.view = [];
  if (!c.done && c.loading) { box.innerHTML = skel(); return; }
  if (!c.done && c.err) { box.innerHTML = '<div class="ws-list">' + errCard(c.err, 'retry') + '</div>'; return; }
  if (c.type === 'deep') h = renderDeep(c);
  else if (!c.items.length && !(c.data && c.data.wiki)) h = '<div class="ws-list"><div class="ws-card ws-err"><p>没有找到结果</p><small>换个说法试试，或者把时间范围放宽' + (c.type !== 'deep' ? '；也可以换一家搜，或者去“深挖”看看' : '') + '</small></div></div>';
  else if (c.type === 'images') h = renderImgs(c.items);
  else if (c.type === 'videos') h = renderVids(c.items);
  else h = renderWeb(c, c.items);
  const tail = [];
  if (c.loading) tail.push('<button type="button" class="ws-btn" disabled>正在搜…</button>');
  else if (c.err) tail.push(errCard(c.err, 'retry'));
  else if (c.type !== 'deep' && (c.used === 'exa' || c.used === 'tavily')) tail.push('<button type="button" class="ws-btn" data-act="swap">换 ' + SRCN[otherSrc(c.used)] + ' 再搜一次，看看别的结果</button>');
  if (c.done && !c.from && /[㐀-鿿]/.test(c.q) && c.type !== 'images') tail.push('<button type="button" class="ws-btn" data-act="q-en">翻成英文再搜一次（外文资料多得多，结果自动翻成中文）</button>');
  if (c.type !== 'deep' && c.type !== 'images' && c.done) tail.push('<button type="button" class="ws-btn" data-act="tab" data-t="deep">去“深挖”看看（档案馆、论文、代码、讨论）</button>');
  if (c.data && c.data.partial) tail.unshift('<div class="ws-note">Exa 和 Tavily 这个月都用完了，上面只有维基共享资源的图</div>');
  if (W.left != null && W.left < 20 && c.type !== 'deep') tail.push('<div class="ws-note">今天还能搜 ' + W.left + ' 次（搜过的词再搜不算）</div>');
  let head = '';
  if (c.from) head += '<div class="ws-qen">已把「' + esc(c.from) + '」翻成英文「' + esc(c.q) + '」来搜<button type="button" data-act="q-back">搜回中文</button></div>';
  if (c.trErr) head += '<div class="ws-qen">结果没翻成中文：' + esc(c.trErr.msg || '翻译出错了') + '</div>';
  box.innerHTML = (head ? '<div class="ws-list" style="padding-bottom:0">' + head + '</div>' : '') + h + (tail.length ? '<div class="ws-list" style="padding-top:0">' + tail.join('') + '</div>' : '');
}
function skel() {
  const card = w => '<div class="ws-card ws-sk"><i style="width:40%"></i><i style="width:' + w + '%;height:16px"></i><i style="width:96%"></i><i style="width:70%;margin:0"></i></div>';
  return '<div class="ws-list">' + card(80) + card(66) + card(74) + '</div>';
}
function errCard(err, act) {
  const how = { nofn: '服务器函数还没部署', nokey: '服务器里的 Exa 或 Tavily 密钥没填，或者填错了', nosql: '搜索那份 SQL 还没运行' }[err.code];
  const stop = /^(limit|off|nokey|nosql|nofn|empty|noArchive|bad)$/.test(err.code);
  return '<div class="ws-card ws-err"><p>' + esc(err.msg || '出错了') + '</p>' + (how ? '<small>' + esc(how) + '</small>' : '') +
    (err.code === 'empty' ? '<button type="button" class="ws-btn pri" data-act="tab" data-t="deep">去“深挖”看看</button>' : '') +
    (stop ? '' : '<button type="button" class="ws-btn pri" data-act="' + act + '">重试</button>') + '</div>';
}
function siteRow(u, extra, i) {
  const h = host(u);
  return '<div class="ws-rt"><span class="m" style="background:' + monoColor(h) + '">' + esc(monoChar(h)) + '</span><span class="h">' + esc(h) + '</span>' + (extra || '') +
    '<button type="button" class="ws-more" data-act="r-more" data-i="' + i + '" aria-label="更多">' + ico(I.more, 18) + '</button></div>';
}
function renderWeb(c, all) {
  let h = '<div class="ws-list">';
  const kg = c.type === 'web' && c.data ? c.data.wiki : null;
  if (kg && kg.t) {
    W.view.push({ u: kg.u, t: kg.t }); const ki = W.view.length - 1;
    h += '<div class="ws-card ws-kg"' + (kg.u ? ' data-act="r-go" data-i="' + ki + '" style="cursor:pointer"' : '') + '>' + (kg.img ? '<img src="' + esc(kg.img) + '" alt="" referrerpolicy="no-referrer" loading="lazy">' : '') +
      '<div class="c"><b>' + esc(tx(kg, 't')) + '</b>' + (kg.s ? '<span class="s">' + esc(tx(kg, 's')) + '</span>' : '') + '<span class="src">' + esc(kg.src || '维基百科') + '</span></div></div>';
  }
  const a = arrange(all); let rows = '';
  a.list.forEach(x => {
    const it = x.it; W.view.push(it); const i = W.view.length - 1;
    const direct = hit(it.u, CFG.direct), vid = vidOf(it.u);
    const tags = (x.pin ? '<span class="ws-tag">置顶</span>' : '') + (x.farm ? '<span class="ws-tag" style="background:var(--surface2);color:var(--muted)">营销号</span>' : '');
    const foot = [it.d, vid ? '点开直接播放' : direct ? '要登录，会用浏览器打开' : ''].filter(Boolean).join(' · ');
    if (c.type === 'news' && it.img) {
      rows += '<div class="ws-r nw" data-act="r-go" data-i="' + i + '"><div class="c">' + siteRow(it.u, tags, i) + '<a class="t" href="' + esc(it.u) + '">' + esc(tx(it, 't') || it.u) + '</a>' +
        (it.s ? '<div class="s">' + esc(tx(it, 's')) + '</div>' : '') + (foot ? '<div class="f">' + esc(foot) + '</div>' : '') + '</div>' +
        '<img src="' + esc(it.img) + '" alt="" referrerpolicy="no-referrer" loading="lazy"></div>';
    } else {
      rows += '<div class="ws-r" data-act="r-go" data-i="' + i + '">' + siteRow(it.u, tags, i) + '<a class="t" href="' + esc(it.u) + '">' + esc(tx(it, 't') || it.u) + '</a>' +
        (it.s ? '<div class="s">' + esc(tx(it, 's')) + '</div>' : '') + (foot ? '<div class="f">' + esc(foot) + '</div>' : '') + '</div>';
    }
  });
  if (rows) h += '<div class="ws-card">' + rows + '</div>';
  if (a.farms) h += '<div class="ws-note">隐藏了 ' + a.farms + ' 条营销号<button type="button" data-act="show-farms">显示</button></div>';
  else if (W.showFarms) h += '<div class="ws-note"><button type="button" data-act="hide-farms">重新隐藏营销号</button></div>';
  if (!rows && all.length) h += '<div class="ws-card ws-err"><p>结果都被你的规则过滤掉了</p><small>可以在搜索规则里改</small></div>';
  return h + '</div>';
}
function renderImgs(all) {
  let h = '<div class="ws-imgs">';
  all.forEach(it => {
    if (it.u && hit(it.u, P.block)) return;
    W.view.push(it); const i = W.view.length - 1;
    const ratio = (it.w && it.h) ? ' style="aspect-ratio:' + it.w + '/' + it.h + '"' : '';
    h += '<div class="ws-im" data-act="img-go" data-i="' + i + '"><img src="' + esc(it.th || it.img) + '" alt="' + esc(it.t || '') + '"' + ratio + ' referrerpolicy="no-referrer" loading="lazy" decoding="async"><span>' + esc(it.src || host(it.u || '')) + '</span></div>';
  });
  return h + '</div>';
}
function renderVids(all) {
  let h = '<div class="ws-list"><div class="ws-card">';
  all.forEach(it => {
    if (hit(it.u, P.block)) return;
    W.view.push(it); const i = W.view.length - 1;
    h += '<div class="ws-vd" data-act="vid-go" data-i="' + i + '"><div class="th"' + (it.img ? ' style="background-image:url(&quot;' + esc(it.img) + '&quot;)"' : '') + '>' + (it.dur ? '<em>' + esc(it.dur) + '</em>' : '') + (it.img ? '' : '<span class="pl">' + ico(I.play, 26) + '</span>') + '</div>' +
      '<div class="c"><b>' + esc(tx(it, 't') || it.u) + '</b><span class="f">' + esc([it.ch, it.src || host(it.u), it.d].filter(Boolean).join(' · ')) + '</span>' + (vidOf(it.u) ? '<span class="f" style="color:var(--ok)">点开直接播放</span>' : '') + '</div></div>';
  });
  return h + '</div></div>';
}
function renderDeep(c) {   // 深挖：几个大数据库的结果按来源分组
  const d = c.data || {}; let h = '<div class="ws-list">';
  (d.groups || []).forEach(g => {
    h += '<div class="ws-card"><div class="ws-gh"><b>' + esc(g.n) + '</b><span>' + g.items.length + ' 条</span></div>';
    g.items.forEach(it => {
      W.view.push(it); const i = W.view.length - 1;
      const foot = (it.f ? esc(it.f) : '') + (it.c ? (it.f ? ' · ' : '') + '<button type="button" class="ws-lnk" data-act="hn-c" data-i="' + i + '">看讨论</button>' : '');
      const body = '<div class="ws-rt"><span class="h">' + esc(host(it.u)) + '</span>' + (it.ext ? '<span class="ws-tag" style="background:var(--surface2);color:var(--muted)">用浏览器打开</span>' : '') +
        '<button type="button" class="ws-more" data-act="r-more" data-i="' + i + '" aria-label="更多">' + ico(I.more, 18) + '</button></div>' +
        '<a class="t" href="' + esc(it.u) + '">' + esc(tx(it, 't') || it.u) + '</a>' + (it.s ? '<div class="s">' + esc(tx(it, 's')) + '</div>' : '') + (foot ? '<div class="f">' + foot + '</div>' : '');
      h += it.img ? '<div class="ws-r nw" data-act="r-go" data-i="' + i + '"><div class="c">' + body + '</div><img src="' + esc(it.img) + '" alt="" referrerpolicy="no-referrer" loading="lazy"></div>'
        : '<div class="ws-r" data-act="r-go" data-i="' + i + '">' + body + '</div>';
    });
    h += '</div>';
  });
  if (!(d.groups || []).length) h += '<div class="ws-card ws-err"><p>这几个数据库里都没找到</p><small>换个说法、或者换成英文试试</small></div>';
  if (d.down && d.down.length) h += '<div class="ws-note">这次没连上：' + esc(d.down.join('、')) + '</div>';
  return h + '</div>';
}

/* ---------- 打开结果 ---------- */
function vidOf(u) {
  let m = /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/)|youtu\.be\/)([\w-]{11})/.exec(u || '');
  if (m) return { src: 'https://www.youtube-nocookie.com/embed/' + m[1] + '?autoplay=1&playsinline=1&rel=0' };
  m = /bilibili\.com\/video\/(BV[0-9A-Za-z]{10})/.exec(u || '');
  if (m) return { src: 'https://player.bilibili.com/player.html?bvid=' + m[1] + '&autoplay=1&high_quality=1&danmaku=0' };
  return null;
}
function ext(u) { try { window.open(u, '_blank', 'noopener'); } catch (e) {} }
function openUrl(u, t) {
  const vid = vidOf(u);
  if (vid) { go('vid', { u: u, t: t, vid: vid }); return; }
  if (hit(u, CFG.direct)) { ext(u); return; }
  go('read', { u: u, t: t });
}
function itemActs(it) {
  const h = host(it.u), items = [];
  const pinned = (P.pin || []).some(d => hit(it.u, [d]));
  items.push({ label: pinned ? '取消置顶 ' + h : '置顶 ' + h + '（排在最前面）', fn: () => { if (pinned) P.pin = P.pin.filter(d => !hit(it.u, [d])); else P.pin = [h].concat(P.pin || []); savePrefs(); renderTop(); B.toast(pinned ? '已取消置顶' : '已置顶 ' + h); } });
  items.push({ label: '不看 ' + h + ' 的结果', fn: () => { P.block = [h].concat((P.block || []).filter(d => d !== h)); savePrefs(); renderTop(); B.toast('以后不显示 ' + h + '，可以在搜索规则里改回来'); } });
  items.push({ label: '用浏览器打开', fn: () => ext(it.u) });
  items.push({ label: '看互联网档案馆的存档', fn: () => go('read', { u: it.u, t: it.t, at: 'latest' }) });
  items.push({ label: '复制链接', fn: () => B.copy(it.u) });
  items.push({ label: '发给好友', fn: () => B.forward((it.t ? it.t + '\n' : '') + it.u) });
  items.push({ label: '取消', fn: null });
  B.acts(h, items);
}

/* ---------- 简洁阅读 ---------- */
const OK_TAG = /^(p|br|h2|h3|h4|h5|h6|ul|ol|li|blockquote|pre|code|em|strong|b|i|u|s|sub|sup|a|img|figure|figcaption|table|thead|tbody|tr|th|td|hr|div)$/;
const BAD_TAG = /^(script|style|iframe|frame|object|embed|svg|math|template|noscript|form|input|button|textarea|select|link|meta|base|video|audio|source)$/;
function sanitize(html) {   // 服务器已经洗过一遍；这里再按白名单重建一遍，只留文字、图片和链接
  const doc = new DOMParser().parseFromString('<!doctype html><body>' + String(html || ''), 'text/html');
  const out = document.createElement('div');
  (function copy(src, dst) {
    Array.prototype.forEach.call(src.childNodes, n => {
      if (n.nodeType === 3) { dst.appendChild(document.createTextNode(n.nodeValue)); return; }
      if (n.nodeType !== 1) return;
      const t = n.tagName.toLowerCase();
      if (BAD_TAG.test(t)) return;
      if (!OK_TAG.test(t)) { copy(n, dst); return; }
      const e = document.createElement(t);
      if (t === 'a') { const hr = n.getAttribute('href') || ''; if (/^https?:\/\//i.test(hr)) e.setAttribute('href', hr); }
      if (t === 'img') {
        const s = n.getAttribute('src') || ''; if (!/^https?:\/\//i.test(s)) return;
        e.setAttribute('src', s); e.setAttribute('alt', n.getAttribute('alt') || ''); e.setAttribute('loading', 'lazy'); e.setAttribute('decoding', 'async'); e.setAttribute('referrerpolicy', 'no-referrer');
      }
      copy(n, e); dst.appendChild(e);
    });
  })(doc.body, out);
  return out;
}
const tsDay = ts => String(ts || '').replace(/^(\d{4})(\d{2})(\d{2}).*/, '$1-$2-$3');
const tsCn = ts => { const m = /^(\d{4})(\d{2})(\d{2})/.exec(String(ts || '')); return m ? m[1] + ' 年 ' + (+m[2]) + ' 月 ' + (+m[3]) + ' 日' : String(ts || ''); };
const archUrl = d => d.art && d.art.arch ? 'https://web.archive.org/web/' + d.art.arch + '/' + (d.art.u || d.u) : (d.art && d.art.u) || d.u;
function seen() { return LSg(uidKey('ch2wsSeen'), []); }
function addSeen(d) {   // 最近看过：打开成功的文章记下来，结果列表变了也能找回
  const a = d.art; if (!a) return;
  const at = a.arch || '', list = seen().filter(x => !(x.u === d.u && (x.at || '') === at));
  list.unshift({ u: d.u, t: a.title, s: a.site, at: at, tm: Date.now() });
  LSs(uidKey('ch2wsSeen'), list.slice(0, 100));
}
function banners(d, final) {   // 阅读页顶部的提醒：仿冒网址、跳到了别的网站
  let h = '';
  const lk = lookAlike(d.u);
  if (lk) h += '<div class="ws-warn"><span><b>小心：</b>' + esc(bare(host(d.u))) + ' 和「' + esc(lk.n) + '」（' + esc(lk.d) + '）只差几个字母，很可能不是' + esc(lk.n) + '，而是仿冒的网站。别在上面输入账号、密码，也别付款。</span>' +
    '<button type="button" data-act="rd-goto" data-u="https://' + esc(lk.d) + '/">去真的' + esc(lk.n) + '（' + esc(lk.d) + '）</button></div>';
  const j = final ? jumped(d.u, final) : '';
  if (j) h += '<div class="ws-jump">这个网址自动跳转到了另一个网站：<b>' + esc(j) + '</b></div>';
  return h;
}
function rdErr(d) {   // 打不开时按原因给按钮：被删了先给存档，要登录先给浏览器，限流先给重试，找不到网站先给搜索
  const e = d.err || {}, look = lookAlike(d.u), q = (d.t && !/^https?:/i.test(d.t) && d.t.length < 80) ? d.t : mainLabel(host(d.u));
  const b = (act, label, pri, extra) => '<button type="button" class="ws-btn' + (pri ? ' pri' : '') + '" data-act="' + act + '"' + (extra || '') + '>' + esc(label) + '</button>';
  const arch = pri => d.at ? '' : b('rd-arch', '看互联网档案馆的存档', pri), orig = pri => b('rd-orig', d.at ? '用浏览器打开这一版存档' : (look ? '仍然用浏览器打开（小心）' : '用浏览器打开原网页'), pri && !look);   // 疑似仿冒的网站：不把“打开原网页”放第一个
  const srch = (label, pri) => q ? b('rd-search', label || '搜索「' + q + '」', pri, ' data-q="' + esc(q) + '"') : '';
  let tip = '', btns = '';
  switch (e.code) {
    case 'nohost': tip = '网址可能打错了，或者这个网站已经关了';
      btns = (look ? b('rd-goto', '你要找的是' + look.n + '吗？去 ' + look.d, true, ' data-u="https://' + esc(look.d) + '/"') : '') + srch('', !look) + arch(false); break;
    case 'gone': tip = '原网页被删了，互联网档案馆里可能还留着以前的版本'; btns = arch(true) + srch(d.t ? '搜这个标题，看别处有没有转载' : '', false) + orig(false); break;
    case 'login': tip = '要登录才能看的网站，用浏览器打开更合适（登录状态在浏览器里）'; btns = orig(true) + arch(false); break;
    case 'busy': tip = d.at ? '互联网档案馆经常这样，已经自动重试过一次；通常等一两分钟再点重试就好' : '对方网站暂时不让频繁访问，等一会儿再试，或者用浏览器打开';
      btns = b('rd-retry', '重试', true) + orig(false) + arch(false); break;
    case 'timeout': tip = d.at ? '互联网档案馆比较慢，再试一次通常就好' : '对方网站反应太慢，再试一次，或者看存档'; btns = b('rd-retry', '重试', true) + arch(false) + orig(false); break;
    case 'down': tip = d.at ? '过一会儿再试' : '对方网站自己出问题了，过一会儿再试，或者看存档'; btns = b('rd-retry', '重试', true) + arch(false) + orig(false); break;
    case 'noArticle': tip = look ? '' : '这种页面用原网页看更合适'; btns = (look ? b('rd-goto', '去真的' + look.n + '（' + look.d + '）', true, ' data-u="https://' + esc(look.d) + '/"') : '') + orig(true) + srch('', false); break;
    case 'notHtml': btns = orig(true); break;
    case 'noArchive': tip = d.at ? '这个网页没被互联网档案馆存过' : ''; btns = orig(true) + srch(d.t ? '搜这个标题，看别处有没有' : '', false); break;
    case 'limit': btns = orig(true); break;
    case 'bad': break;
    case 'net': tip = '手机这边的网络不太好'; btns = b('rd-retry', '重试', true); break;
    default: tip = d.at ? '' : '对方网站连不上，可能暂时出问题了'; btns = b('rd-retry', '重试', true) + arch(false) + orig(false);
  }
  return '<div class="ws-card ws-err"><p>' + esc(e.msg || '打不开') + '</p>' + (tip ? '<small>' + esc(tip) + '</small>' : '') + btns + '</div>';
}
function renderRead(t) {
  const d = t.d;
  R('rsite').textContent = host(d.u) + (d.at ? ' · 存档' : '');
  R('rtool').style.display = d.art ? '' : 'none';
  const favd = (P.fav || []).some(f => f.u === d.u && (f.at || '') === ((d.art && d.art.arch) || ''));
  const fb = R('rtool').querySelector('[data-act="rd-fav"]'); fb.classList.toggle('on', favd); fb.lastChild.nodeValue = favd ? '已收藏' : '收藏';
  if (W.shownRead === t && !d.dirty) return;
  W.shownRead = t; d.dirty = false;
  const box = R('read');
  if (d.art) {
    const a = d.art;
    const arch = a.arch ? '<div class="ws-arch"><span>互联网档案馆 ' + esc(tsDay(a.arch)) + ' 的存档</span><button type="button" data-act="rd-vers">别的版本</button><button type="button" data-act="rd-now">看现在的</button></div>' : '';
    const from = '<div class="ws-from">来源：<a href="' + esc(a.u || d.u) + '" data-act="rd-orig">' + esc(host(a.u || d.u)) + '</a></div>';
    if (a.kind === 'links') {   // 首页、目录页：页面上的链接，点了接着在 App 里看
      const ls = a.links || [];
      box.innerHTML = '<div class="ws-art">' + banners(d, a.u) + arch + '<div class="ws-trb" hidden></div><h1>' + esc(a.title || host(a.u || d.u)) + '</h1><div class="ws-ot" hidden></div>' +
        '<div class="meta">' + esc([a.site, '不是文章，下面是页面上的 ' + ls.length + ' 个链接'].filter(Boolean).join(' · ')) + '</div>' + (a.desc ? '<p class="ws-desc">' + esc(a.desc) + '</p>' : '') +
        '<div class="ws-card ws-lks">' + ls.map((l, i) => '<div class="ws-row" data-act="lk-go" data-i="' + i + '"><span class="ws-tx"><span class="lt">' + esc(l.t) + '</span><span class="ws-sub">' + esc(host(l.u)) + '</span></span>' + ico(I.chev, 15) + '</div>').join('') + '</div>' + from + '</div>';
    } else {
      const mins = Math.max(1, Math.round((a.len || 0) / 450));
      box.innerHTML = '<article class="ws-art" style="font-size:' + W.fs + 'px">' + banners(d, a.u) + arch + '<div class="ws-trb" hidden></div>' +
        '<h1>' + esc(a.title) + '</h1><div class="ws-ot" hidden></div><div class="meta">' + esc([a.site, a.date, '约 ' + mins + ' 分钟读完'].filter(Boolean).join(' · ')) + '</div>' +
        (a.img ? '<img class="ws-lead" src="' + esc(a.img) + '" alt="" referrerpolicy="no-referrer">' : '') + '<div class="ws-body"></div>' + from + '</article>';
      box.querySelector('.ws-body').appendChild(sanitize(a.html));
    }
    initTr(t);
    return;
  }
  R('rdsc').scrollTop = 0;
  if (d.err) { box.innerHTML = '<div class="ws-list" style="padding-top:18px">' + banners(d, d.err.to) + rdErr(d) + '</div>'; return; }
  box.innerHTML = '<div class="ws-art">' + banners(d, '') + '<h1 style="opacity:.55">' + esc(d.t || '正在打开…') + '</h1><div class="meta">' + esc(host(d.u)) + (d.at ? ' · 正在从互联网档案馆取存档（档案馆比较慢，可能要等半分钟）' : ' · 正在整理成简洁版') + '</div>' + skel().replace('ws-list', 'ws-list" style="padding:0') + '</div>';
  if (!d.loading) fetchRead(t);
}

/* ---------- 翻译：外文网页、外文搜索结果换成中文（服务器用智谱翻；同一段 30 天内不重复翻，手机里也记一份） ---------- */
const FL = /[A-Za-zÀ-ɏͰ-ϿЀ-ӿ֐-׿؀-ۿ฀-๿぀-ヿ가-힯]/g, HAN = /[㐀-鿿]/g, JK = /[぀-ヿ가-힯]/g;
function foreign(s, min) {   // 外文为主（日文、韩文也算外文）
  s = String(s || '').slice(0, 4000);
  const han = (s.match(HAN) || []).length, jk = (s.match(JK) || []).length, fl = (s.match(FL) || []).length;
  if (jk >= 3 && jk >= han * 0.2) return true;
  return fl >= (min || 2) && han < fl * 0.3;
}
const BLK = 'p,h2,h3,h4,h5,h6,li,blockquote,figcaption,td,th,dt,dd,div';
function trUnits(root) {   // 要翻译的最小段落；段落里面还套着段落的，把直接写在里面的零散文字包起来单独翻
  const out = []; if (!root) return out;
  root.querySelectorAll(BLK).forEach(el => {
    if (el.closest('pre')) return;
    if (!el.querySelector(BLK)) { out.push(el); return; }
    let run = [];
    const flush = () => {
      if (run.some(n => (n.textContent || '').trim())) { const sp = document.createElement('span'); sp.className = 'ws-run'; el.insertBefore(sp, run[0]); run.forEach(n => sp.appendChild(n)); out.push(sp); }
      run = [];
    };
    Array.from(el.childNodes).forEach(n => {
      if (n.nodeType === 1 && (n.matches(BLK) || /^(UL|OL|TABLE|PRE|FIGURE|HR|IMG|BLOCKQUOTE)$/.test(n.tagName))) flush();
      else if (n.nodeType === 3 || n.nodeType === 1) run.push(n);
    });
    flush();
  });
  return out;
}
function packUnit(el) {   // 发给服务器的段落：链接地址、图片换成编号（省字数，也防止被翻坏），回来再换回去
  const map = [], c = el.cloneNode(true);
  c.querySelectorAll('*').forEach(n => {
    const tag = n.tagName.toLowerCase(), keep = tag === 'a' ? (n.getAttribute('href') || '') : tag === 'img' ? n.cloneNode(false) : null;
    Array.from(n.attributes).forEach(x => n.removeAttribute(x.name));
    if (keep !== null) { n.setAttribute('i', String(map.length)); map.push(keep); }
  });
  return { html: c.innerHTML.replace(/\s+/g, ' ').trim(), map: map };
}
function unpack(str, map) {   // 译文按白名单重建：只留文字、加粗斜体代码、换行，链接和图片按编号还原
  const doc = new DOMParser().parseFromString('<!doctype html><body>' + String(str || ''), 'text/html');
  const frag = document.createDocumentFragment();
  (function copy(src, dst) {
    Array.prototype.forEach.call(src.childNodes, n => {
      if (n.nodeType === 3) { dst.appendChild(document.createTextNode(n.nodeValue)); return; }
      if (n.nodeType !== 1) return;
      const t = n.tagName.toLowerCase();
      if (t === 'img') { const o = map[+n.getAttribute('i')]; if (o && o.nodeType === 1) dst.appendChild(o.cloneNode(false)); return; }
      if (BAD_TAG.test(t)) return;
      if (!/^(a|b|strong|i|em|u|s|sub|sup|code|br)$/.test(t)) { copy(n, dst); return; }
      const e = document.createElement(t);
      if (t === 'a') { const h = map[+n.getAttribute('i')]; if (typeof h === 'string' && /^https?:\/\//i.test(h)) e.setAttribute('href', h); }
      copy(n, e); dst.appendChild(e);
    });
  })(doc.body, frag);
  return frag;
}
const TRWHY = { blocked: '翻译服务按国内规定拒绝翻译这些内容', busy: '翻译服务太忙', toolong: '段落太长', upstream: '翻译服务出错', badkey: '翻译密钥不对', empty: '翻译额度用完了' };
function trBar(t) {
  const d = t.d, tr = d.tr, box = R('read'); if (top() !== t || !tr) return;
  const bar = box.querySelector('.ws-trb'); if (!bar) return;
  const ot = box.querySelector('.ws-ot'), tu = (tr.units || []).find(u => u.el.tagName === 'H1');
  if (ot) { const t0 = (d.art && d.art.title) || ''; ot.hidden = !(tr.on && tu && tu.t && tu.t.textContent.trim() !== t0.trim()); ot.textContent = '原标题：' + t0; }
  let h = '', cls = '';
  if (!tr.foreign) h = '';
  else if (tr.err) { cls = 'err'; h = '<span>' + esc(tr.err.msg || '翻译出错了') + '</span>' + (tr.err.code === 'nokey' ? '' : '<button type="button" data-act="tr-go">重试</button>'); }
  else if (tr.busy) h = '<span>正在翻译成中文… ' + tr.done + ' / ' + tr.total + ' 段</span><button type="button" data-act="tr-orig">看原文</button>';
  else if (tr.on) h = '<span>已翻译成中文' + (tr.failed ? '（有 ' + tr.failed + ' 段没翻成：' + esc(tr.why.map(w => TRWHY[w] || w).join('、') || '翻译服务出错') + '，显示原文）' : '') + '</span>' + (tr.failed ? '<button type="button" data-act="tr-go">再试一次</button>' : '') + '<button type="button" data-act="tr-orig">看原文</button>';
  else if (tr.started) h = '<span>正在看原文</span><button type="button" data-act="tr-go">看译文</button>';
  else h = '<span>这是外文网页</span><button type="button" data-act="tr-go">翻译成中文</button>';
  bar.hidden = !h; bar.className = 'ws-trb' + (cls ? ' ' + cls : ''); bar.innerHTML = h;
}
function initTr(t) {   // 页面画好以后：找出外文段落；外文为主就自动翻（规则里可以关）
  const d = t.d, box = R('read'), links = d.art.kind === 'links';
  const els = [box.querySelector('h1')].concat(links ? [box.querySelector('.ws-desc')].concat(Array.from(box.querySelectorAll('.ws-lks .lt'))) : trUnits(box.querySelector('.ws-body')));
  let all = 0, fz = 0; const units = [];
  els.forEach(el => { if (!el) return; const s = el.textContent || '', n = s.replace(/\s+/g, '').length; all += n; if (foreign(s)) { fz += n; units.push(el); } });
  const tr = d.tr || (d.tr = { on: false, started: false });
  tr.gen = (tr.gen || 0) + 1; tr.busy = false; tr.err = null;
  tr.units = units.map(el => Object.assign({ el: el }, packUnit(el))).filter(u => u.html);
  tr.foreign = tr.units.length > 0 && fz >= 40 && fz >= all * 0.5;
  if (tr.foreign && (tr.on || (!tr.started && P.autoTr !== false))) { startTr(t); return; }
  trBar(t);
}
function applyUnit(u) {
  const s = W.trc.get(u.html); if (s == null) return false;
  if (!u.o) { u.o = document.createDocumentFragment(); while (u.el.firstChild) u.o.appendChild(u.el.firstChild); }
  if (!u.t) u.t = unpack(s, u.map);
  u.el.replaceChildren(u.t.cloneNode(true));
  return true;
}
function showOrig(t) {
  const tr = t.d.tr; if (!tr) return;
  tr.on = false; (tr.units || []).forEach(u => { if (u.o) u.el.replaceChildren(u.o.cloneNode(true)); });
  trBar(t);
}
async function startTr(t) {
  const d = t.d, tr = d.tr; if (!tr || !tr.units) return;
  tr.on = true; tr.started = true; tr.err = null; tr.failed = 0; tr.why = [];
  const account = accountRevision, gen = tr.gen, pending = tr.units.filter(u => !applyUnit(u));   // 手机里记着的先直接换上
  tr.total = tr.units.length; tr.done = tr.total - pending.length;
  if (!pending.length || tr.busy) { trBar(t); return; }
  tr.busy = true; trBar(t);
  const batches = []; let cur = [], n = 0;   // 第一批小一点（标题和开头几段），几秒就能先看到
  pending.forEach(u => { const lim = batches.length ? 6000 : 1500; if (cur.length && (cur.length >= 30 || n + u.html.length > lim)) { batches.push(cur); cur = []; n = 0; } cur.push(u); n += u.html.length; });
  if (cur.length) batches.push(cur);
  for (const bt of batches) {
    const r = await B.call({ op: 'translate', html: true, items: bt.map(u => u.html) }, 90000);
    if (account !== accountRevision || tr.gen !== gen) return;   // 页面重画过了：这批结果交给新的那一轮
    if (!r || !r.ok) { tr.err = r || { code: 'net', msg: '翻译出错了' }; break; }
    bt.forEach((u, k) => { const s = r.items && r.items[k]; if (s) { if (W.trc.size > 4000) W.trc.clear(); W.trc.set(u.html, s); if (tr.on) applyUnit(u); tr.done++; } else tr.failed++; });
    (r.why || []).forEach(w => { if (tr.why.indexOf(w) < 0) tr.why.push(w); });
    trBar(t);
  }
  tr.busy = false; trBar(t);
}
async function trRes(c) {   // 搜索结果：外文的标题和摘要翻成中文
  if (!c || c.tr === 'busy') return;
  const items = [], tgt = [];
  const push = (o, k) => { const s = o && o[k]; if (s && foreign(s)) { tgt.push([o, k]); items.push(String(s)); } };
  const list = c.type === 'deep' ? [].concat.apply([], ((c.data && c.data.groups) || []).map(g => g.items || [])) : (c.items || []);
  list.forEach(it => { push(it, 't'); push(it, 's'); });
  if (c.data && c.data.wiki) { push(c.data.wiki, 't'); push(c.data.wiki, 's'); }
  const need = [];
  tgt.forEach((x, i) => { const z = W.trc.get('p|' + items[i]); if (z != null) x[0][x[1] + 'z'] = z; else need.push(i); });
  c.trOn = true; c.trErr = null;
  if (!need.length) { c.tr = 'done'; renderRes(); return; }
  c.tr = 'busy'; renderRes();
  for (let s = 0; s < need.length; s += 40) {
    const part = need.slice(s, s + 40);
    const r = await B.call({ op: 'translate', items: part.map(i => items[i]) }, 90000);
    if (W.cur !== c) return;
    if (!r || !r.ok) { c.tr = 'err'; c.trErr = r || { msg: '翻译出错了' }; c.trOn = false; renderRes(); return; }
    part.forEach((i, k) => { const z = r.items && r.items[k]; if (z) { W.trc.set('p|' + items[i], z); tgt[i][0][tgt[i][1] + 'z'] = z; } });
    renderRes();
  }
  c.tr = 'done'; renderRes();
}
function resForeign(c) {   // 结果大多是外文吗
  const list = c.type === 'deep' ? [].concat.apply([], ((c.data && c.data.groups) || []).map(g => g.items || [])) : (c.items || []);
  const n = list.filter(it => foreign(it.t) || foreign(it.s)).length;
  return c.type === 'deep' ? n >= 3 : n >= Math.max(2, list.length * 0.4);
}
const tx = (it, k) => (W.cur && W.cur.trOn && it[k + 'z']) || it[k];
async function qEn(c) {   // 中文搜索词翻成英文再搜：外文资料多得多，结果再自动翻成中文
  let en = W.trc.get('en|' + c.q);
  if (!en) {
    B.toast('正在把搜索词翻成英文…');
    const r = await B.call({ op: 'translate', to: 'en', items: [c.q] }, 30000);
    if (W.cur !== c) return;
    if (!r || !r.ok || !r.items || !r.items[0]) { B.toast((r && r.msg) || '没翻成英文，稍后再试'); return; }
    en = String(r.items[0]).replace(/^["'“”‘’]+|["'“”‘’。.]+$/g, '').replace(/\s+/g, ' ').trim().slice(0, 200);
    W.trc.set('en|' + c.q, en);
  }
  if (W.cur === c) search(en, c.type === 'images' ? 'web' : c.type, '', c.q);
}
async function fetchRead(t) {
  const account = accountRevision, d = t.d; d.loading = true;
  const r = await B.call({ op: 'read', url: d.u, at: d.at || '' }, d.at ? 45000 : 25000);
  if (account !== accountRevision) return;
  d.loading = false; d.dirty = true;
  if (r && r.ok) { d.art = r; addSeen(d); } else d.err = r || { code: 'net', msg: '出错了' };
  if (top() === t) renderRead(t);
}
async function showVersions(d) {
  const account = accountRevision;
  B.toast('正在查互联网档案馆…');
  const r = await B.call({ op: 'versions', url: d.u }, 25000);
  if (account !== accountRevision) return;
  if (!r || !r.ok) { B.toast((r && r.msg) || '查不到存档'); return; }
  if (!r.list || !r.list.length) { B.toast('互联网档案馆里没有这个网页的存档'); return; }
  const cur = d.art && d.art.arch;
  B.acts('历史版本（共 ' + r.list.length + ' 个，最近的在前）', r.list.slice(0, 40).map(ts => ({ label: tsCn(ts) + (cur && cur.slice(0, 8) === ts.slice(0, 8) ? '（正在看）' : ''), fn: () => go('read', { u: d.u, t: d.art ? d.art.title : d.t, at: ts }) })).concat([{ label: '取消', fn: null }]));
}
function readerLink(a) {
  const hr = a.getAttribute('href') || ''; if (!/^https?:\/\//i.test(hr)) return;
  openUrl(hr, a.textContent.trim().slice(0, 80));
}

/* ---------- 看大图、播放视频 ---------- */
function renderImg(t) {
  const it = t.d.it || {};
  R('isite').textContent = it.src || host(it.u || '');
  R('itxt').innerHTML = esc(it.t || '') + (it.w && it.h ? '<small>' + it.w + ' × ' + it.h + '</small>' : '');
  const box = R('ibig'); box.innerHTML = '';
  const im = new Image(); im.alt = it.t || ''; im.referrerPolicy = 'no-referrer';
  let tried = 0;
  im.onerror = () => { if (!tried && it.th && im.src !== it.th) { tried = 1; im.src = it.th; return; } box.innerHTML = '<p>图片加载不出来，可以点下面用浏览器看原图</p>'; };
  im.src = it.img || it.th; box.appendChild(im);
  V('img').querySelector('[data-act="img-page"]').style.display = it.u ? '' : 'none';
}
function renderVid(t) {
  const d = t.d;
  R('vsite').textContent = host(d.u);
  const box = R('vbox');
  if (box.dataset.src === d.vid.src && box.firstChild) return;
  box.dataset.src = d.vid.src;
  box.innerHTML = '<div style="width:100%"><iframe class="ws-player" src="' + esc(d.vid.src) + '" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen referrerpolicy="strict-origin-when-cross-origin" title="视频"></iframe>' +
    '<div class="ws-dkt" style="padding-top:14px">' + esc(d.t || '') + '<small>' + esc(host(d.u)) + ' · 放不出来的话点“在原网站打开”</small></div></div>';
}

/* ---------- 搜索规则 ---------- */
function renderRules() {
  const sw = (act, on, t, sub) => '<div class="ws-row" data-act="' + act + '" style="cursor:pointer"><span class="ws-tx" style="white-space:normal">' + t + '<span class="ws-sub" style="white-space:normal">' + sub + '</span></span><button type="button" class="ws-sw" role="switch" aria-checked="' + (on ? 'true' : 'false') + '" aria-label="' + t + '" data-act="' + act + '"></button></div>';
  const list = (k, empty) => {
    const a = P[k] || [];
    return (a.length ? a.map(d => '<div class="ws-row"><span class="ws-mono" style="width:26px;height:26px;border-radius:8px;background:' + monoColor(d) + ';color:#fff;font-size:12px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0">' + esc(monoChar(d)) + '</span><span class="ws-tx">' + esc(d) + '</span><button type="button" class="ws-x" data-act="rule-del" data-k="' + k + '" data-d="' + esc(d) + '" aria-label="删掉">' + ico(I.x, 15) + '</button></div>').join('') : '<div class="ws-row" style="color:var(--muted);font-size:14px">' + empty + '</div>') +
      '<button type="button" class="ws-row" data-act="rule-add" data-k="' + k + '" style="color:var(--accent)">' + ico(I.plus, 18) + '<span class="ws-tx">添加网站</span></button>';
  };
  const use = s => (W.keys && W.keys[s] === false) ? '还没填密钥' : (W.used[s] != null ? '用了 ' + W.used[s] + ' / ' + (W.free[s] || '?') + ' 次' : '…');
  const h = '<div class="ws-sec" style="margin-top:10px">排序和过滤</div><div class="ws-card">' +
    sw('tgl-clean', P.clean, '干净页面优先', '维基百科、GitHub、政府和学校网站往前排') +
    sw('tgl-farm', P.hideFarms, '不看营销号', '百家号、搜狐号、360doc 这类不显示') +
    '<div class="ws-row" data-act="pref-src" style="cursor:pointer"><span class="ws-tx">网页先用哪家搜<span class="ws-sub">这家用完了会自动换另一家</span></span><span class="ws-val">' + SRCN[P.src === 'tavily' ? 'tavily' : 'exa'] + '</span>' + ico(I.chev, 16) + '</div></div>' +
    '<div class="ws-sec">这个月的次数</div><div class="ws-card">' +
      '<div class="ws-row"><span class="ws-tx" style="white-space:normal">Exa<span class="ws-sub" style="white-space:normal">网页、新闻、视频默认用它；每月免费约 ' + (W.free.exa || 2500) + ' 次</span></span><span class="ws-val">' + esc(use('exa')) + '</span></div>' +
      '<div class="ws-row"><span class="ws-tx" style="white-space:normal">Tavily<span class="ws-sub" style="white-space:normal">图片先用它，Exa 用完时顶上；每月免费 ' + (W.free.tavily || 1000) + ' 次</span></span><span class="ws-val">' + esc(use('tavily')) + '</span></div></div>' +
    '<div class="ws-hint">两家都每月自动恢复：Tavily 是每月 1 号，Exa 按月刷新（官网没写具体哪一天）。同一个词 24 小时内再搜不算次数；“深挖”和打开网页不花这些次数。' + (W.left != null ? '你今天还能搜 ' + W.left + ' 次。' : '') + '</div>' +
    '<div class="ws-sec">翻译</div><div class="ws-card">' +
      sw('tgl-tr', P.autoTr !== false, '外文自动翻译成中文', '外文网页、外文搜索结果打开就翻；关掉以后要自己点“翻译成中文”') +
      '<div class="ws-row"><span class="ws-tx" style="white-space:normal">智谱（免费）<span class="ws-sub" style="white-space:normal">主要的翻译服务；按国内规定会拒绝翻译一些内容</span></span><span class="ws-val">' + (W.keys ? (W.keys.glm ? '已开通' : '还没填密钥') : '…') + '</span></div>' +
      '<div class="ws-row"><span class="ws-tx" style="white-space:normal">Groq（备用，可不填）<span class="ws-sub" style="white-space:normal">智谱拒绝或太忙的段落交给它</span></span><span class="ws-val">' + (W.keys ? (W.keys.groq ? '已开通' : '没填') : '…') + '</span></div></div>' +
    '<div class="ws-hint">翻过的段落 30 天内再看不用重翻。</div>' +
    '<div class="ws-sec">置顶网站</div><div class="ws-card">' + list('pin', '还没有') + '</div>' +
    '<div class="ws-sec">不看的网站</div><div class="ws-card">' + list('block', '还没有') + '</div>' +
    '<div class="ws-sec">默认名单</div><div class="ws-card">' +
      '<details><summary>营销号（' + CFG.farms.length + ' 个）</summary><p>' + esc(CFG.farms.join('、')) + '</p></details>' +
      '<details><summary>干净网站（' + CFG.clean.length + ' 个）</summary><p>' + esc(CFG.clean.join('、')) + '</p></details>' +
      '<details><summary>直接用浏览器打开（' + CFG.direct.length + ' 个）</summary><p>要登录或者不让取内容的网站。' + esc(CFG.direct.join('、')) + '</p></details></div>' +
    '<div class="ws-hint">你的规则存在账号里，换手机也在。默认名单在数据库里，改了不用更新 App。</div>';
  R('rules').innerHTML = h;
}
function addSite(k) {
  B.form(k === 'pin' ? '置顶网站' : '不看的网站', [{ ph: '网址，例如 github.com', max: 120, type: 'url' }], async vals => {
    const d = normSite(vals[0]); if (!d) return '网址不对，例如 github.com';
    P[k] = [d].concat((P[k] || []).filter(x => x !== d)).slice(0, 60);
    const other = k === 'pin' ? 'block' : 'pin'; P[other] = (P[other] || []).filter(x => x !== d);
    savePrefs(); renderTop(); return null;
  }, '添加');
}

/* ---------- 点击 ---------- */
function onClick(e) {
  const el = e.target.closest('[data-act]'); if (!el || !root.contains(el)) {
    const a = e.target.closest('.ws-body a[href]'); if (a) { e.preventDefault(); readerLink(a); }
    const im = e.target.closest('.ws-body img'); if (im) go('img', { it: { img: im.getAttribute('src'), t: im.getAttribute('alt') || '' } });
    return;
  }
  const act = el.dataset.act;
  if (el.tagName === 'A' || e.target.closest('a')) e.preventDefault();
  const t = top(), c = W.cur, it = W.view && W.view[+el.dataset.i];
  switch (act) {
    case 'back': back(); break;
    case 'rules': go('rules'); loadUsage(); break;
    case 'clear': { const f = el.closest('.ws-field'), inp = f.querySelector('input'); inp.value = ''; f.classList.remove('has'); inp.focus(); break; }
    case 'type': {
      W.type = el.dataset.t; renderHome();
      const q = V('home').querySelector('input').value.trim(); if (q) search(q, W.type);
      break;
    }
    case 'tab': if (c && (c.type !== el.dataset.t || el.dataset.t === 'deep')) { W.type = el.dataset.t; search(c.q, W.type, '', c.from); } break;
    case 'go-q': search(el.dataset.q, W.type); break;
    case 'hist-del': e.stopPropagation(); LSs(uidKey('ch2wsHist'), hist().filter(x => x !== el.dataset.q)); renderHome(); break;
    case 'hist-clear': LSs(uidKey('ch2wsHist'), []); renderHome(); break;
    case 'seen-clear': LSs(uidKey('ch2wsSeen'), []); renderHome(); break;
    case 'seen-go': { const s = seen()[+el.dataset.i]; if (s) go('read', { u: s.u, t: s.t, at: s.at || '' }); break; }
    case 'pin-add': addSite('pin'); break;
    case 'pin-go': { const inp = V('home').querySelector('input'); inp.value = 'site:' + el.dataset.d + ' '; inp.closest('.ws-field').classList.add('has'); inp.focus(); break; }
    case 'fav-go': { const f = (P.fav || [])[+el.dataset.i]; if (f) { if (f.at) go('read', { u: f.u, t: f.t, at: f.at }); else openUrl(f.u, f.t); } break; }
    case 'fav-all': B.acts('收藏的文章', (P.fav || []).slice(0, 60).map(f => ({ label: (f.t || f.u).slice(0, 40), fn: () => { if (f.at) go('read', { u: f.u, t: f.t, at: f.at }); else openUrl(f.u, f.t); } })).concat([{ label: '取消', fn: null }])); break;
    case 'r-go': if (it && it.u) { if (it.ext) ext(it.u); else openUrl(it.u, it.t); } break;
    case 'r-more': e.stopPropagation(); if (it) itemActs(it); break;
    case 'hn-c': e.stopPropagation(); if (it && it.c) openUrl(it.c, it.t); break;
    case 'retry': if (c) { c.err = null; c.done = false; fetchRes(); } break;
    case 'swap': if (c && c.used) search(c.q, c.type, otherSrc(c.used), c.from); break;
    case 'src': if (c) B.acts('用哪家搜', [['exa', 'Exa'], ['tavily', 'Tavily']].map(x => ({ label: x[1] + usageText(x[0]) + (c.used === x[0] ? ' ✓' : ''), fn: () => { if (c.used !== x[0]) search(c.q, c.type, x[0], c.from); } })).concat([{ label: '取消', fn: null }])); break;
    case 'show-farms': W.showFarms = true; renderRes(); break;
    case 'hide-farms': W.showFarms = false; renderRes(); break;
    case 'tgl-clean': P.clean = !P.clean; savePrefs(); renderTop(); break;
    case 'tgl-farm': P.hideFarms = !P.hideFarms; W.showFarms = false; savePrefs(); renderTop(); break;
    case 'tbs': B.acts('时间范围', TBS.map(x => ({ label: x[1] + ((c && (c.tbs || '') === x[0]) ? ' ✓' : ''), fn: () => { W.tbs = x[0]; if (c) search(c.q, c.type, c.src, c.from); } })).concat([{ label: '取消', fn: null }])); break;
    case 'pref-src': B.acts('网页先用哪家搜', [['exa', 'Exa（免费次数多，推荐）'], ['tavily', 'Tavily']].map(x => ({ label: x[1] + ((P.src === 'tavily' ? 'tavily' : 'exa') === x[0] ? ' ✓' : ''), fn: () => { P.src = x[0] === 'exa' ? '' : x[0]; savePrefs(); renderTop(); } })).concat([{ label: '取消', fn: null }])); break;
    case 'rule-add': addSite(el.dataset.k); break;
    case 'rule-del': P[el.dataset.k] = (P[el.dataset.k] || []).filter(x => x !== el.dataset.d); savePrefs(); renderTop(); break;
    case 'img-go': if (it) go('img', { it: it }); break;
    case 'img-page': { const x = t && t.d.it; if (x && x.u) openUrl(x.u, x.t); break; }
    case 'img-raw': { const x = t && t.d.it; if (x) ext(x.img || x.th); break; }
    case 'vid-go': if (it && it.u) { const vid = vidOf(it.u); if (vid) go('vid', { u: it.u, t: it.t, vid: vid }); else ext(it.u); } break;
    case 'vid-out': if (t && t.d.u) ext(t.d.u); break;
    case 'vid-send': if (t && t.d.u) B.forward((t.d.t ? t.d.t + '\n' : '') + t.d.u); break;
    case 'rd-orig': if (t && t.d.u) ext(archUrl(t.d)); break;
    case 'rd-retry': if (t) { t.d.err = null; t.d.dirty = true; renderRead(t); } break;
    case 'rd-arch': if (t) go('read', { u: t.d.u, t: t.d.t, at: 'latest' }); break;
    case 'rd-now': if (t) openUrl(t.d.u, t.d.art && t.d.art.title); break;
    case 'rd-vers': if (t) showVersions(t.d); break;
    case 'rd-fs': {
      W.fs = SIZES[(SIZES.indexOf(W.fs) + 1) % SIZES.length] || 18; LSs('ch2wsFs', W.fs);
      const a = R('read').querySelector('.ws-art'); if (a) a.style.fontSize = W.fs + 'px';
      B.toast('字号：' + ['小', '标准', '大', '特大'][SIZES.indexOf(W.fs)]); break;
    }
    case 'rd-fav': {
      if (!t || !t.d.art) break;
      const u = t.d.u, at = t.d.art.arch || '', same = f => f.u === u && (f.at || '') === at, had = (P.fav || []).some(same);
      P.fav = had ? P.fav.filter(f => !same(f)) : [{ u: u, t: t.d.art.title, s: t.d.art.site + (at ? ' · ' + tsDay(at) + ' 存档' : ''), at: at, tm: Date.now() }].concat(P.fav || []).slice(0, 200);
      savePrefs(); t.d.dirty = false; renderRead(t); B.toast(had ? '已取消收藏' : '已收藏，搜索首页能看到'); break;
    }
    case 'rd-copy': if (t) B.copy(archUrl(t.d)); break;
    case 'rd-send': if (t) B.forward(((t.d.art && t.d.art.title) ? t.d.art.title + '\n' : '') + archUrl(t.d)); break;
    case 'rd-goto': if (el.dataset.u) openUrl(el.dataset.u); break;
    case 'rd-search': if (el.dataset.q) search(el.dataset.q, 'web'); break;
    case 'lk-go': { const a = t && t.d.art, l = a && a.links && a.links[+el.dataset.i]; if (l) { if (a.arch) go('read', { u: l.u, t: l.t, at: a.arch }); else openUrl(l.u, l.t); } break; }
    case 'tr-go': if (t && t.d.tr) startTr(t); break;
    case 'tr-orig': if (t) showOrig(t); break;
    case 'res-tr': if (c) { if (c.trOn) { c.trOn = false; renderRes(); } else if (c.tr === 'done') { c.trOn = true; renderRes(); } else trRes(c); } break;
    case 'q-en': if (c) qEn(c); break;
    case 'q-back': if (c && c.from) search(c.from, c.type === 'images' ? 'web' : c.type); break;
    case 'tgl-tr': P.autoTr = P.autoTr === false; savePrefs(); renderTop(); break;
  }
}

window.ChatterSearch = { open: open, onPop: onPop, isOpen: () => W.on, closeNow: close, resetAccount, _w: W, _hit: hit, _arrange: arrange, _sanitize: sanitize, _vidOf: vidOf, _lookAlike: lookAlike, _foreign: foreign, _jumped: jumped, _unpack: unpack, _pack: packUnit };
})();
