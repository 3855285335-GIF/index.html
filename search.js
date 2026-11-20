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
  reload: '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.5 4.5v4h-4"/>',
  read: '<path d="M5 6h14M5 10h14M5 14h10M5 18h7"/>',
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
  img: '<rect x="3.5" y="4.5" width="17" height="15" rx="3"/><circle cx="9" cy="10" r="1.8"/><path d="M20 16l-5-5-8 8.5"/>',
  up: '<path d="M6 15l6-6 6 6"/>',
  speak: '<path d="M4.5 9.5v5h3.5l4.5 4v-13l-4.5 4z"/><path d="M16 9a4.5 4.5 0 0 1 0 6"/><path d="M18.5 6.5a8 8 0 0 1 0 11"/>',
  stop: '<rect x="6.5" y="6.5" width="11" height="11" rx="2.5"/>',
  globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17"/><path d="M12 3.5c2.4 2.6 3.5 5.5 3.5 8.5s-1.1 5.9-3.5 8.5c-2.4-2.6-3.5-5.5-3.5-8.5s1.1-5.9 3.5-8.5z"/>'
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
  // 视频网站：点了直接打开原网站（Safari 窗口），不变成文字
  video: ['iqiyi.com', 'youku.com', 'v.qq.com', 'douyin.com', 'ixigua.com', 'kuaishou.com', 'mgtv.com', 'acfun.cn', 'tiktok.com', 'vimeo.com', 'twitch.tv', 'dailymotion.com', 'nicovideo.jp', 'huya.com', 'douyu.com', 'haokan.baidu.com', 'tv.sohu.com', 'le.com', 'miguvideo.com', 'yangshipin.cn', 'weibo.com/tv', 'youtube.com', 'youtu.be', 'bilibili.com', 'b23.tv'],
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
  ['farms', 'clean', 'direct', 'video'].forEach(k => { if (Array.isArray(v[k])) CFG[k] = v[k].map(String); });
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
  const prefs = P; prefs._syncAt = Date.now();
  try {
    const r = await B.sb().from('search_prefs').select('prefs, updated_at').maybeSingle();
    if (P !== prefs || B.uid() !== prefs._uid) return;
    const d = r && r.data;
    if (d && d.prefs && (Date.parse(d.updated_at) || 0) > (P._at || 0)) {
      P = Object.assign(prefsDef(), d.prefs, { _uid: P._uid, _at: Date.parse(d.updated_at) || 0, _syncAt: Date.now() });
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
    const body = Object.assign({}, prefs); delete body._uid; delete body._at; delete body._syncAt;
    try {
      const r = await B.sb().from('search_prefs').upsert({ uid: prefs._uid, prefs: body, updated_at: new Date().toISOString() }, { onConflict: 'uid' });
      if (r && r.error) B.logErr('ws-prefs', r.error);
    } catch (e) { B.logErr('ws-prefs', e); }
  }, 800);
}
function hist() { return LSg(uidKey('ch2wsHist'), []); }
function addHist(q) { if (P && P.noHist) return; LSs(uidKey('ch2wsHist'), [q].concat(hist().filter(x => x !== q)).slice(0, 30)); }

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
.ws-wbar{gap:0}
.ws-web{flex:1;min-height:0;position:relative;background:var(--bg);display:flex;flex-direction:column}
.ws-web>.ws-sc{flex:1}
.ws-web iframe{position:absolute;inset:0;width:100%;height:100%;border:0;background:#fff}
.ws-wload{position:absolute;inset:0;z-index:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;color:var(--muted);font-size:14px;background:var(--bg);padding:0 24px;text-align:center}
.ws-wload .sp{width:26px;height:26px;border-radius:50%;border:3px solid var(--line);border-top-color:var(--accent);animation:wsspin .8s linear infinite}
@keyframes wsspin{to{transform:rotate(360deg)}}
.ws-wtip{display:flex;align-items:center;gap:8px;padding:8px 8px 8px 14px;padding-bottom:calc(8px + env(safe-area-inset-bottom));font-size:13px;color:var(--muted);background:var(--surface);border-top:1px solid var(--line);flex-shrink:0}
.ws-wtip[hidden]{display:none}
.ws-wtip span{flex:1;min-width:0}
.ws-wtip .ws-chip{height:32px;font-size:13px;flex-shrink:0}
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
.ws-tool{display:grid;grid-template-columns:repeat(7,1fr);padding:6px 8px calc(6px + env(safe-area-inset-bottom));background:var(--surface);border-top:1px solid var(--line);flex-shrink:0}
.ws-tool button{display:flex;flex-direction:column;align-items:center;gap:3px;font-size:10.5px;white-space:nowrap;color:var(--ink);background:transparent;min-height:48px;justify-content:center;border-radius:12px;padding:4px}
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
.ws-trb[hidden]{display:none}
.ws-ot{font-size:13px;color:var(--muted);margin:-4px 0 10px;line-height:1.5}
.ws-desc{font-size:14px;color:var(--muted);line-height:1.65;margin:0 0 14px}
.ws-lks .ws-row{min-height:56px;cursor:pointer}
.ws-lks .ws-tx{white-space:normal;line-height:1.45}
.ws-qen{font-size:13px;color:var(--muted);padding:2px 4px 0;line-height:1.6}
.ws-qen button{background:transparent;padding:0 2px;color:var(--accent);font-size:13px}
/* 收藏、浏览记录、输入联想、页内查找、朗读、手机里保存的文章 */
.ws-quick{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:16px}
.ws-quick button{display:flex;align-items:center;gap:8px;height:48px;padding:0 14px;border-radius:16px;background:var(--surface);box-shadow:var(--shadow);color:var(--ink);font-size:15px;min-width:0}
.ws-quick button svg{color:var(--accent);flex-shrink:0}
.ws-quick b{margin-left:auto;font-weight:500;color:var(--muted);font-size:13px}
.ws-sec .ws-secb{display:flex;gap:14px}
.ws-sug{position:absolute;left:12px;right:12px;top:calc(64px + env(safe-area-inset-top));z-index:6;max-width:736px;margin:0 auto;background:var(--surface);border-radius:18px;box-shadow:0 14px 36px rgba(0,0,0,.2);overflow-y:auto;max-height:min(60vh,430px)}
.ws-sug[hidden]{display:none}
.ws-sug .ws-row{cursor:pointer}
.ws-sug .ws-row>svg{color:var(--accent)}
.ws-fl{padding:0 12px 6px;flex-shrink:0}
.ws-fl input{width:100%;height:40px;border-radius:14px;border:0;background:var(--surface);box-shadow:var(--shadow);padding:0 14px;font-size:15px;color:var(--ink)}
.ws-empty{text-align:center;color:var(--muted);font-size:14px;line-height:1.75;padding:56px 16px}
.ws-day{font-size:12.5px;color:var(--muted);margin:20px 6px 8px}
.ws-day:first-child{margin-top:8px}
.ws-note2{margin:6px 0 12px;padding:10px 12px;border-radius:14px;background:var(--surface2);font-size:13px;color:var(--muted);line-height:1.55}
.ws-ttl{color:var(--ink)!important;font-size:16px!important;font-weight:600}
.ws-barb{height:34px;padding:0 10px;border-radius:12px;background:transparent;color:var(--accent);font-size:14px;flex-shrink:0}
.ws-urlb{background:transparent;padding:6px 4px;border-radius:10px;min-width:0;height:auto;box-shadow:none}
.ws-find{display:flex;align-items:center;gap:4px;padding:0 10px 8px;flex-shrink:0}
.ws-find[hidden]{display:none}
.ws-find input::-webkit-search-cancel-button,.ws-fl input::-webkit-search-cancel-button{display:none}
.ws-find input{flex:1;min-width:0;height:38px;border-radius:12px;border:0;background:var(--surface);box-shadow:var(--shadow);padding:0 12px;font-size:15px;color:var(--ink)}
.ws-find span{font-size:12.5px;color:var(--muted);min-width:46px;text-align:center;white-space:nowrap}
.ws-find button{width:36px;height:36px;border-radius:12px;background:transparent;color:var(--ink);display:flex;align-items:center;justify-content:center;padding:0;flex-shrink:0}
mark.ws-hl{background:color-mix(in srgb,#ffc928 55%,transparent);color:inherit;border-radius:3px;padding:0 1px}
mark.ws-hl.cur{background:#ff9f1a;color:#1b1b1b}
.ws-say{background:color-mix(in srgb,var(--accent) 12%,transparent);border-radius:6px;box-shadow:0 0 0 4px color-mix(in srgb,var(--accent) 12%,transparent)}
.ws-cache{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:12.5px;color:var(--muted);margin:-6px 0 14px}
.ws-cache button{background:transparent;padding:2px 0;color:var(--accent);font-size:12.5px;height:auto}
.ws-tag.off{background:color-mix(in srgb,var(--ok) 16%,transparent);color:var(--ok)}
.ws-r.offr{background:color-mix(in srgb,var(--ok) 6%,transparent)}
`;

/* ---------- 界面骨架 ---------- */
let root = null, accountRevision = 0;
const W = { on: false, stack: [], type: 'web', tbs: '', cur: null, seq: 0, left: null, showFarms: false, fs: LSg('ch2wsFs', 18), shownRead: null, view: [], used: {}, free: { exa: 2500, tavily: 1000 }, keys: null, trc: new Map(), frm: new Map(), webT: 0, tipT: 0, quiet: false, flt: {}, sug: [], fnd: { q: '', marks: [], i: -1 } };   // frm：哪些网址能嵌进 App（问过服务器的，记 10 分钟）
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
    '<section class="ws-v" data-v="home">' + bar('home', '搜索，或者粘贴网址', rulesBtn) + '<div class="ws-sug" data-r="sug-home" hidden></div><div class="ws-chips ws-in" data-r="types"></div><div class="ws-sc"><div class="ws-pad ws-in" data-r="home"></div></div></section>' +
    '<section class="ws-v" data-v="res">' + bar('res', '搜索', rulesBtn) + '<div class="ws-sug" data-r="sug-res" hidden></div><div class="ws-tabs ws-in" data-r="tabs"></div><div class="ws-sc" data-r="rsc"><div class="ws-in"><div class="ws-chips" data-r="filters" style="padding:10px 12px 6px"></div><div data-r="res"></div></div></div></section>' +
    '<section class="ws-v" data-v="read"><div class="ws-bar ws-in"><button type="button" class="ws-ib" data-act="back" aria-label="返回">' + ico(I.back) + '</button><span class="ws-site" data-r="rsite"></span><button type="button" class="ws-chip" data-act="rd-orig" style="height:34px;font-size:13px;margin-right:6px">原网页</button></div>' +
      '<div class="ws-find ws-in" data-r="find" hidden><input type="search" enterkeyhint="search" autocomplete="off" placeholder="在这篇文章里找" aria-label="在这篇文章里找"><span data-r="fcount"></span><button type="button" data-act="find-prev" aria-label="上一个">' + ico(I.up, 20) + '</button><button type="button" data-act="find-next" aria-label="下一个">' + ico(I.down, 20) + '</button><button type="button" data-act="find-x" aria-label="关掉查找">' + ico(I.x, 18) + '</button></div>' +
      '<div class="ws-sc" data-r="rdsc"><div class="ws-in" data-r="read"></div></div>' +
      '<div class="ws-tool" data-r="rtool"><button type="button" data-act="rd-fs">' + ico(I.size) + '字号</button><button type="button" data-act="rd-find">' + ico(I.find) + '查找</button><button type="button" data-act="rd-say">' + ico(I.speak) + '朗读</button><button type="button" data-act="rd-fav">' + ico(I.mark) + '收藏</button><button type="button" data-act="rd-vers">' + ico(I.clock) + '历史版本</button><button type="button" data-act="rd-copy">' + ico(I.link) + '复制链接</button><button type="button" data-act="rd-send">' + ico(I.send) + '发给好友</button></div></section>' +
    '<section class="ws-v" data-v="web"><div class="ws-bar ws-in ws-wbar"><button type="button" class="ws-ib" data-act="web-close" aria-label="关闭网页">' + ico(I.x) + '</button><button type="button" class="ws-ib" data-act="back" aria-label="后退">' + ico(I.back) + '</button><button type="button" class="ws-site ws-urlb" data-r="wsite" data-act="web-url" aria-label="网址"></button><button type="button" class="ws-ib" data-act="web-sheet" aria-label="用 Safari 窗口打开">' + ico(I.out) + '</button><button type="button" class="ws-ib" data-act="web-more" aria-label="更多">' + ico(I.more) + '</button></div>' +
      '<div class="ws-web" data-r="wbox"></div><div class="ws-wtip" data-r="wtip" hidden></div></section>' +
    '<section class="ws-v" data-v="favs"><div class="ws-bar ws-in"><button type="button" class="ws-ib" data-act="back" aria-label="返回">' + ico(I.back) + '</button><span class="ws-site ws-ttl">收藏</span><span style="width:50px"></span></div><div class="ws-fl ws-in"><input type="search" data-filter="favs" enterkeyhint="search" autocomplete="off" placeholder="在收藏里找" aria-label="在收藏里找"></div><div class="ws-sc"><div class="ws-pad ws-in" data-r="favs"></div></div></section>' +
    '<section class="ws-v" data-v="hist"><div class="ws-bar ws-in"><button type="button" class="ws-ib" data-act="back" aria-label="返回">' + ico(I.back) + '</button><span class="ws-site ws-ttl">浏览记录</span><button type="button" class="ws-barb" data-act="seen-wipe">清空</button></div><div class="ws-fl ws-in"><input type="search" data-filter="hist" enterkeyhint="search" autocomplete="off" placeholder="在浏览记录里找" aria-label="在浏览记录里找"></div><div class="ws-sc"><div class="ws-pad ws-in" data-r="hist"></div></div></section>' +
    '<section class="ws-v" data-v="rules"><div class="ws-bar ws-in"><button type="button" class="ws-ib" data-act="back" aria-label="返回">' + ico(I.back) + '</button><span class="ws-site" style="color:var(--ink);font-size:16px;font-weight:600">搜索规则</span><span style="width:50px"></span></div><div class="ws-sc"><div class="ws-pad ws-in ws-rules" data-r="rules"></div></div></section>' +
    '<section class="ws-v dk" data-v="img"><div class="ws-bar"><button type="button" class="ws-ib" data-act="back" aria-label="返回">' + ico(I.back) + '</button><span class="ws-site" data-r="isite"></span><span style="width:50px"></span></div><div class="ws-big" data-r="ibig"></div><div class="ws-dkt" data-r="itxt"></div><div class="ws-dkb"><button type="button" data-act="img-page">打开来源网页</button><button type="button" data-act="img-raw">用 Safari 窗口看原图</button></div></section>' +
    '<section class="ws-v dk" data-v="vid"><div class="ws-bar"><button type="button" class="ws-ib" data-act="back" aria-label="返回">' + ico(I.back) + '</button><span class="ws-site" data-r="vsite"></span><span style="width:50px"></span></div><div class="ws-big" style="align-items:flex-start;padding:0" data-r="vbox"></div><div class="ws-dkb"><button type="button" data-act="vid-out">在原网站打开</button><button type="button" data-act="vid-send">发给好友</button></div></section>';
  (document.querySelector('.app-container') || document.body).appendChild(root);
  root.addEventListener('click', onClick);
  root.addEventListener('submit', e => { e.preventDefault(); const f = e.target; const inp = f.querySelector('input'); try { inp.blur(); } catch (x) {} sugHide(); search(inp.value, W.type); });
  root.addEventListener('input', e => {
    const f = e.target.closest && e.target.closest('.ws-field'); if (f) { f.classList.toggle('has', !!e.target.value); sugShow(f.dataset.form, e.target.value); }
    const fl = e.target.dataset && e.target.dataset.filter; if (fl) { W.flt[fl] = e.target.value; if (fl === 'favs') renderFavs(); else renderHistory(); }
    if (e.target.closest && e.target.closest('[data-r="find"]')) { clearTimeout(W.fndT); const v = e.target.value; W.fndT = setTimeout(() => findRun(v), 220); }
  });
  root.addEventListener('mousedown', e => { if (e.target.closest && e.target.closest('.ws-sug')) e.preventDefault(); });   // 点联想时输入框不失去焦点
  root.addEventListener('focusin', e => { const f = e.target.closest && e.target.closest('.ws-field'); if (f && e.target.value) sugShow(f.dataset.form, e.target.value); });
  root.addEventListener('focusout', e => { if (e.target.closest && e.target.closest('.ws-field')) setTimeout(() => { const a = document.activeElement; if (!a || !a.closest || !a.closest('.ws-field')) sugHide(); }, 180); });
  root.addEventListener('keydown', e => {
    if (e.key === 'Escape') sugHide();
    if (e.key === 'Enter' && e.target.closest && e.target.closest('[data-r="find"]')) { e.preventDefault(); clearTimeout(W.fndT); if (W.fnd.q !== e.target.value.trim()) findRun(e.target.value); else findStep(e.shiftKey ? -1 : 1); }
  });
  root.querySelector('[data-r="rdsc"]').addEventListener('scroll', () => { clearTimeout(W.posT); W.posT = setTimeout(savePos, 500); }, { passive: true });
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
  else if (t.v === 'web') renderPage(t);
  else if (t.v === 'favs') renderFavs();
  else if (t.v === 'hist') renderHistory();
  if (TTS.on && TTS.t !== t) ttsStop();   // 离开正在朗读的文章就停
  sugHide();
  if (t.v !== 'vid') { R('vbox').innerHTML = ''; R('vbox').dataset.src = ''; }   // 离开播放页就停掉视频
  if (t.v !== 'web') unmountWeb();   // 离开网页那一层：网页框拿掉（停掉里面的声音、视频）
  const sc = scroller(t.v); if (sc && t.y != null) sc.scrollTop = t.y;   // 回到上一层时停在原来看到的位置
}
function go(v, d) {
  const cur = top(); if (cur) { const sc = scroller(cur.v); if (sc) cur.y = sc.scrollTop; if (cur.v === 'read') { clearTimeout(W.posT); savePos(); } }
  W.stack.push({ v: v, d: d || {} });
  try { history.pushState({ ws: W.stack.length }, '', location.href); } catch (e) {}
  show();
}
function back() {
  if (history.state && history.state.ws) { try { history.back(); return; } catch (e) {} }
  popTo(W.stack.length - 1);
}
function popTo(n) {
  const cur = top(); if (cur && cur.v === 'read') { clearTimeout(W.posT); savePos(); }   // 离开文章时记下看到哪了
  W.stack.length = Math.max(0, Math.min(n, W.stack.length));
  if (!W.stack.length) { close(); return; }
  if (W.quiet) return;   // 正在从网页那一层退出来，接下来马上要换到别的页面：先不画，免得闪一下
  show();
}
function close() {
  W.on = false; W.stack.length = 0;
  ttsStop();
  if (root) { root.classList.remove('on'); R('vbox').innerHTML = ''; R('vbox').dataset.src = ''; unmountWeb(); sugHide(); }
  document.body.classList.remove('ws-open');
}
function resetAccount() {
  accountRevision++;
  ttsStop(); artClose();
  clearTimeout(saveT); P = null;
  close();
  W.seq++; W.cur = null; W.shownRead = null; W.view = []; W.trc.clear(); W.frm.clear();
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
  if (P && Date.now() - (P._syncAt || 0) > 60000) syncPrefs();   // App 一直开着时，别的手机上改的收藏、规则也要拿过来（服务器上的更新才用）
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
  const nf = (P.fav || []).length, ns = seen().length;
  let h = '<div class="ws-quick"><button type="button" data-act="favs">' + ico(I.mark, 19) + '收藏<b>' + (nf || '') + '</b></button><button type="button" data-act="hist">' + ico(I.clock, 19) + '浏览记录<b>' + (P.noHist ? '不记' : (ns || '')) + '</b></button></div>';
  h += '<div class="ws-sec">置顶网站</div><div class="ws-grid">';
  (P.pin || []).slice(0, 14).forEach(d => {
    const hs = d.split('/')[0];
    h += '<button type="button" class="ws-tile" data-act="pin-go" data-d="' + esc(d) + '"><span class="ws-mono" style="color:' + monoColor(hs) + '">' + esc(monoChar(hs)) + '</span><span>' + esc(hs.replace(/\.(com|org|net|cn|io)$/, '')) + '</span></button>';
  });
  h += '<button type="button" class="ws-tile" data-act="pin-add"><span class="ws-mono add">' + ico(I.plus, 20) + '</span><span style="color:var(--muted)">添加</span></button></div>';
  if (!(P.pin || []).length) h += '<div class="ws-hint">置顶的网站排在结果最前面；点一下只搜这个网站。</div>';
  const often = oftenSites();
  if (often.length) {
    h += '<div class="ws-sec">常去的网站</div><div class="ws-grid">';
    often.forEach(x => { h += '<button type="button" class="ws-tile" data-act="often-go" data-d="' + esc(x.h) + '"><span class="ws-mono" style="color:' + monoColor(x.h) + '">' + esc(monoChar(x.h)) + '</span><span>' + esc(x.h.replace(/\.(com|org|net|cn|io)$/, '')) + '</span></button>'; });
    h += '</div>';
  }
  const fav = (P.fav || []).slice(0, 3);
  if (fav.length) {
    h += '<div class="ws-sec">收藏的文章' + '<button type="button" data-act="favs">全部 ' + P.fav.length + ' 个</button>' + '</div><div class="ws-card">';
    fav.forEach((f, i) => { h += '<div class="ws-row" data-act="fav-go" data-i="' + i + '">' + ico(I.mark, 17) + '<span class="ws-tx">' + esc(f.t || f.u) + '<span class="ws-sub">' + esc(f.s || host(f.u)) + '</span></span></div>'; });
    h += '</div>';
  }
  const sn = seen().slice(0, 5);
  if (sn.length) {
    h += '<div class="ws-sec">最近看过<span class="ws-secb"><button type="button" data-act="hist">全部记录</button><button type="button" data-act="seen-clear">清空</button></span></div><div class="ws-card">';
    sn.forEach((x, i) => { h += '<div class="ws-row" data-act="seen-go" data-i="' + i + '" style="cursor:pointer">' + ico(x.m === 'web' ? I.globe : I.read, 16) + '<span class="ws-tx">' + esc(x.t || host(x.u) || x.u) + '<span class="ws-sub">' + esc(entrySub(x)) + '</span></span></div>'; });
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
function officialOf(c) {   // 这次搜索的官网：先看维基数据给的“官方网站”，再看知名网站名单里名字对不对得上
  if (!c || c.type !== 'web' && c.type !== 'news') return null;
  const w = c.data && c.data.wiki && c.data.wiki.site, wh = w && bare(host(w));
  if (wh) return { h: wh, u: w, n: (c.data.wiki.t || wh) };
  const q = String(c.q || '').toLowerCase(), qs = q.replace(/\s+/g, '');
  for (const p of CFG.popular || []) {
    const name = String(p[1] || '').toLowerCase().replace(/\s+/g, ''), lab = mainLabel(p[0]);
    if ((name.length >= 2 && qs.indexOf(name) >= 0) || (lab.length >= 3 && new RegExp('(^|[^a-z0-9])' + lab + '([^a-z0-9]|$)').test(q)) || qs === p[0]) return { h: p[0], u: 'https://' + (p[0].split('.').length === 2 ? 'www.' : '') + p[0] + '/', n: p[1] };
  }
  return null;
}
function isOff(u, c, off) {   // 这条结果是不是官网
  const hs = host(u), h = bare(hs); if (!h) return false;
  if (off && (h === off.h || h.endsWith('.' + off.h))) return true;
  const toks = String(c.q || '').toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/g) || [];   // 搜 supabase、github copilot：supabase.com、github.com 就是官网
  return toks.indexOf(mainLabel(h)) >= 0 && /^[^.]+\.(com|cn|com\.cn|net|org|io|dev|app|ai|co)$/.test(h);
}
function arrange(items) {   // 按你的规则：官网排第一，不看的网站去掉，营销号去掉，置顶的排前面，干净的往前挪 3 位
  let farms = 0; const out = [], c = W.cur, off = officialOf(c);
  items.forEach((it, i) => {
    if (!it || !it.u) return;
    if (hit(it.u, P.block)) return;
    const farm = hit(it.u, CFG.farms);
    if (farm && P.hideFarms && !W.showFarms) { farms++; return; }
    const pin = hit(it.u, P.pin), clean = !!P.clean && hit(it.u, CFG.clean), offi = !!c && isOff(it.u, c, off);
    out.push({ it: it, i: i, pin: pin, clean: clean, farm: farm, off: offi, score: i - (offi ? 100000 : 0) - (pin ? 1000 : 0) - (clean ? 3 : 0) });
  });
  out.sort((a, b) => a.score - b.score || a.i - b.i);
  if (off && !out.some(x => x.off) && !hit(off.u, P.block)) out.unshift({ it: { t: off.n + '（官网）', u: off.u, s: '官方网站 · ' + off.h }, i: -1, off: true, pin: false, clean: false, farm: false, score: -1e9 });   // 结果里没有官网：补一条在最前面
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
    const tags = (x.off ? '<span class="ws-tag off">官网</span>' : '') + (x.pin ? '<span class="ws-tag">置顶</span>' : '') + (x.farm ? '<span class="ws-tag" style="background:var(--surface2);color:var(--muted)">营销号</span>' : '');
    const foot = [it.d, vid ? '点开直接播放' : ''].filter(Boolean).join(' · ');
    if (c.type === 'news' && it.img) {
      rows += '<div class="ws-r nw" data-act="r-go" data-i="' + i + '"><div class="c">' + siteRow(it.u, tags, i) + '<a class="t" href="' + esc(it.u) + '">' + esc(tx(it, 't') || it.u) + '</a>' +
        (it.s ? '<div class="s">' + esc(tx(it, 's')) + '</div>' : '') + (foot ? '<div class="f">' + esc(foot) + '</div>' : '') + '</div>' +
        '<img src="' + esc(it.img) + '" alt="" referrerpolicy="no-referrer" loading="lazy"></div>';
    } else {
      rows += '<div class="ws-r' + (x.off ? ' offr' : '') + '" data-act="r-go" data-i="' + i + '">' + siteRow(it.u, tags, i) + '<a class="t" href="' + esc(it.u) + '">' + esc(tx(it, 't') || it.u) + '</a>' +
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
/* 用 iPhone 自带的 Safari 窗口打开：从主屏幕打开的 Chatter 里，点到别的网站会在 App 里弹出 Safari 窗口（点“完成”回到 Chatter，不会切到 Safari App）。
   什么网站都能打开（不受“禁止嵌入”限制），电脑版网页也会自动缩放，视频照常播。在 Safari 浏览器里用 Chatter 时，就开一个新标签页。 */
const standalone = () => { try { return navigator.standalone === true || !!(window.matchMedia && window.matchMedia('(display-mode: standalone)').matches); } catch (e) { return false; } };
function ext(u) {
  if (!u) return;
  if (standalone()) { try { const a = document.createElement('a'); a.href = u; a.rel = 'noreferrer'; a.style.display = 'none'; document.body.appendChild(a); a.click(); a.remove(); return; } catch (e) { /* 换下面的办法 */ } }
  try { window.open(u, '_blank', 'noopener'); } catch (e) {}
}
function openSheet(u, t) { addVisit({ u: u, t: t || '', s: host(u), m: 'web' }); ext(u); }
function openUrl(u, t) {
  const vid = vidOf(u);
  if (vid) { go('vid', { u: u, t: t, vid: vid }); return; }
  if (lookAlike(u) || (P.open === 'read' && !hit(u, CFG.direct) && !hit(u, CFG.video))) { go('read', { u: u, t: t }); return; }   // 像仿冒网站（简洁阅读那边有红色提醒），或者自己设了“先用简洁阅读”
  if (hit(u, CFG.video) || P.open === 'sheet') { openSheet(u, t); return; }   // 视频网站、设了“总是用 Safari 窗口”：直接打开原网站
  go('web', { u: u, t: t });
}
function openOrig(u, t, extra) {   // “原网页”：先在 App 里显示；已经知道这个网站不让嵌，就直接用系统浏览器
  const f = W.frm.get(u);
  if (f && f.frame === false) { ext(f.url || u); return; }
  go('web', Object.assign({ u: u, t: t }, extra || {}));
}
function openPage(u, t) {   // 聊天里点的链接也在这里打开（不跳出 App）
  build(); loadPrefs(); loadCfg();
  if (!W.on) { W.on = true; root.classList.add('on'); document.body.classList.add('ws-open'); }
  openUrl(u, t);
}

/* ---------- App 里的网页（原网页） ----------
   网页由手机直接打开、嵌在 App 里，不经过我们的服务器、不转发内容（这不是代理，也不是 VPN）。
   很多大网站（谷歌、知乎、B 站、推特……）自己设了“不许别的网站嵌入”，嵌进来会是一片空白，
   所以先让服务器看一眼对方的响应头：不让嵌就换简洁阅读，并说清原因。
   网页里点过的链接会留在浏览器历史里：返回键、左上角“‹”先在网页里后退，退到头再回上一层；“×”直接关掉。 */
const WHY = { xfo: '这个网站不允许在别的 App 里显示原网页', csp: '这个网站不允许在别的 App 里显示原网页', http: '这个网站没有加密（http），App 里不能直接显示', pdf: '这是 PDF 文件', file: '这是文件，不是网页' };
function renderPage(t) {   // 原网页这一层
  const d = t.d, box = R('wbox');
  R('wsite').textContent = host(d.src || d.u);
  if (d.fail) { unmountWeb(); box.innerHTML = webFail(d); return; }
  if (d.src) { if (box.dataset.src !== d.src) mountWeb(t); return; }
  if (box.dataset.src || !box.querySelector('.ws-wload')) { unmountWeb(); box.innerHTML = '<div class="ws-wload"><div class="sp"></div><div>正在打开 ' + esc(host(d.u)) + '…</div></div>'; }
  if (!d.probing) probeWeb(t);
}
async function probeWeb(t) {
  const d = t.d, account = accountRevision; d.probing = true;
  let f = W.frm.get(d.u);
  if (!f || Date.now() - f.at > 10 * 60000) {
    const r = await B.call({ op: 'frame', url: d.u }, 12000);
    if (account !== accountRevision) return;
    f = (r && r.ok) ? { frame: r.frame, why: r.why || '', url: r.url || d.u, code: r.code || '', mobile: r.mobile, at: Date.now() } : { frame: null, why: '', url: d.u, code: (r && r.code) || 'net', at: Date.now() };
    if (r && r.ok) W.frm.set(d.u, f);
  }
  d.probing = false;
  if (top() !== t) return;   // 已经离开这一页
  let src = '';
  try { const x = new URL(f.url || d.u); if (x.protocol === 'https:' && x.origin !== location.origin) src = x.href; } catch (e) { /* 网址不对 */ }
  // 手机仍显示联网但搜索服务连接失败时，收藏的本机副本也能打开。
  if (f.frame === null && f.code === 'net' && !d.fromRead && isFav(d.u, '')) {
    const saved = await artGet(d.u, '');
    if (account !== accountRevision || top() !== t) return;
    if (saved?.art?.ok) { replaceTop(t, 'read', { u: d.u, t: d.t }); return; }
  }
  if (f.frame === null && /^(nohost|gone|bad)$/.test(f.code)) { replaceTop(t, 'read', { u: d.u, t: d.t }); return; }   // 找不到网站、被删了：简洁阅读那边有按原因的提示和按钮（看存档、去真的网站）
  if (f.frame === false || !src || f.mobile === false) {   // 嵌不进 App、电脑版网页（没做手机适配）：用 Safari 窗口打开原网站，不变成文字
    const why = f.mobile === false && src && f.frame !== false ? '这是电脑版网页，没做手机适配' : (WHY[f.why] || (src ? '这个网站不允许在别的 App 里显示原网页' : '这个网址不能在 App 里打开'));
    const url = f.url || d.u;
    if (!d.fromRead && standalone()) { addVisit({ u: d.u, t: d.t, s: host(url), m: 'web' }); leaveWeb(() => { show(); ext(url); }); return; }   // 主屏幕版：退回上一页，同时弹出 Safari 窗口
    d.fail = { why: why, url: url }; show(); return;   // 在 Safari 浏览器里：要点一下才能开新标签页（不然会被拦）
  }
  d.src = src; d.unsure = f.frame === null;
  addVisit({ u: d.u, t: d.t, s: host(src), m: 'web' });
  show();
}
function replaceTop(t, v, d) { if (top() !== t) return; t.v = v; t.d = d; W.shownRead = null; show(); }   // 同一层换成别的页面，不多一条历史
function mountWeb(t) {
  const d = t.d, box = R('wbox');
  unmountWeb();
  box.dataset.src = d.src;
  const ld = document.createElement('div'); ld.className = 'ws-wload'; ld.innerHTML = '<div class="sp"></div><div>正在打开 ' + esc(host(d.src)) + '…</div>';
  const fr = document.createElement('iframe');
  // 网页在自己的来源里运行，碰不到 Chatter 的登录信息；不给它跳转整个 App、弹对话框的权限
  fr.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads');
  fr.setAttribute('allow', 'fullscreen; autoplay; encrypted-media; picture-in-picture; clipboard-write');
  fr.setAttribute('referrerpolicy', 'no-referrer');
  fr.setAttribute('title', d.t || host(d.src));
  fr.addEventListener('load', () => {
    d.loads = (d.loads || 0) + 1; ld.remove();
    if (d.loads === 1 && !d.tipped) { d.tipped = true; webTip(t, d.unsure ? '服务器没能确认这个网站让不让在 App 里显示。' : '', d.unsure ? 0 : 6000); }
  });
  box.appendChild(ld); box.appendChild(fr);
  fr.src = d.src;
  clearTimeout(W.webT); W.webT = setTimeout(() => { if (top() === t && !d.loads) webTip(t, '打开得有点慢。', 0); }, 9000);
  if (foreign(d.t || '') && !d.trTip) { d.trTip = true; webTip(t, '外文网页。', 0, true); }
}
function unmountWeb() {
  if (!root) return;
  const box = R('wbox'); if (box) { box.innerHTML = ''; box.dataset.src = ''; }
  const tip = R('wtip'); if (tip) tip.hidden = true;
  clearTimeout(W.webT); clearTimeout(W.tipT);
}
function webTip(t, msg, hideMs, tr) {   // 网页下面的小提示：看不到内容就用 Safari 窗口打开
  const tip = R('wtip'); if (!tip || top() !== t) return;
  tip.innerHTML = '<span>' + esc(msg + (tr ? '' : '看不到内容？')) + '</span><button type="button" class="ws-chip" data-act="' + (tr ? 'web-read' : 'web-sheet') + '">' + (tr ? '翻成中文看' : '用 Safari 窗口打开') + '</button><button type="button" class="ws-x" data-act="web-tipx" aria-label="关掉提示">' + ico(I.x, 14) + '</button>';
  tip.hidden = false;
  clearTimeout(W.tipT); if (hideMs) W.tipT = setTimeout(() => { if (top() === t) tip.hidden = true; }, hideMs);
}
function webFail(d) {
  const login = hit(d.u, CFG.direct);
  const b = (act, label, pri) => '<button type="button" class="ws-btn' + (pri ? ' pri' : '') + '" data-act="' + act + '">' + esc(label) + '</button>';
  return '<div class="ws-sc"><div class="ws-list" style="padding-top:18px"><div class="ws-card ws-err"><p>' + esc(d.fail.why) + '</p><small>' +
    esc(login ? '这类网站要登录才能看：在 Safari 窗口里打开，登录一次就行。' : '点下面的按钮，用 iPhone 自带的 Safari 窗口打开原网站（在 Chatter 里弹出，点“完成”回来）。') + '</small>' +
    b('web-ext', '用 Safari 窗口打开', true) + (d.fromRead ? b('back', '返回简洁阅读', false) : b('web-read', '试试简洁阅读', false)) + '</div></div></div>';
}
function leaveWeb(next) {   // 退出网页那一层：网页里点过的链接在浏览器历史里留下了记录，一步步退回进来之前那一层；next：退完以后要去的页面
  const depth = W.stack.length; let n = 0;
  unmountWeb();
  W.quiet = !!next;
  const done = () => { W.quiet = false; if (next) next(); else show(); };
  const step = () => {
    if (!W.on) { W.quiet = false; return; }
    if (W.stack.length < depth) { done(); return; }
    if (n++ >= 40 || !(history.state && history.state.ws)) { W.stack.length = depth - 1; if (!W.stack.length && !next) { W.quiet = false; close(); return; } done(); return; }
    try { history.back(); } catch (e) { W.stack.length = depth - 1; done(); return; }
    setTimeout(step, 200);
  };
  step();
}
function itemActs(it) {
  const h = host(it.u), items = [];
  const pinned = (P.pin || []).some(d => hit(it.u, [d]));
  items.push({ label: pinned ? '取消置顶 ' + h : '置顶 ' + h + '（排在最前面）', fn: () => { if (pinned) P.pin = P.pin.filter(d => !hit(it.u, [d])); else P.pin = [h].concat(P.pin || []); savePrefs(); renderTop(); B.toast(pinned ? '已取消置顶' : '已置顶 ' + h); } });
  items.push({ label: '不看 ' + h + ' 的结果', fn: () => { P.block = [h].concat((P.block || []).filter(d => d !== h)); savePrefs(); renderTop(); B.toast('以后不显示 ' + h + '，可以在搜索规则里改回来'); } });
  const fv = isFav(it.u, '');
  items.push({ label: fv ? '取消收藏' : '收藏', fn: () => { const on = toggleFav({ u: it.u, t: it.t, s: h }); renderTop(); B.toast(on ? '已收藏，在搜索首页的“收藏”里' : '已取消收藏'); } });
  items.push({ label: '用 Safari 窗口打开', fn: () => openSheet(it.u, it.t) });
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
function addSeen(d) {   // 最近看过：简洁阅读打开成功的文章记下来，结果列表变了也能找回
  const a = d.art; if (!a) return;
  addVisit({ u: d.u, t: a.title, s: a.site, at: a.arch || '', m: 'read' });
}
function banners(d, final) {   // 阅读页顶部的提醒：仿冒网址、跳到了别的网站
  let h = '';
  const lk = lookAlike(d.u);
  if (lk) h += '<div class="ws-warn"><span><b>小心：</b>' + esc(bare(host(d.u))) + ' 和「' + esc(lk.n) + '」（' + esc(lk.d) + '）只差几个字母，很可能不是' + esc(lk.n) + '，而是仿冒的网站。别在上面输入账号、密码，也别付款。</span>' +
    '<button type="button" data-act="rd-goto" data-u="https://' + esc(lk.d) + '/">去真的' + esc(lk.n) + '（' + esc(lk.d) + '）</button></div>';
  const j = final ? jumped(d.u, final) : '';
  if (j) h += '<div class="ws-jump">这个网址自动跳转到了另一个网站：<b>' + esc(j) + '</b></div>';
  if (d.note) h += '<div class="ws-jump">' + esc(d.note) + '　<button type="button" class="ws-lnk" data-act="rd-ext">用 Safari 窗口打开原网页</button></div>';
  return h;
}
function rdErr(d) {   // 打不开时按原因给按钮：被删了先给存档，要登录先给浏览器，限流先给重试，找不到网站先给搜索
  const e = d.err || {}, look = lookAlike(d.u), q = (d.t && !/^https?:/i.test(d.t) && d.t.length < 80) ? d.t : mainLabel(host(d.u));
  const b = (act, label, pri, extra) => '<button type="button" class="ws-btn' + (pri ? ' pri' : '') + '" data-act="' + act + '"' + (extra || '') + '>' + esc(label) + '</button>';
  const arch = pri => d.at ? '' : b('rd-arch', '看互联网档案馆的存档', pri), orig = pri => b('rd-orig', d.at ? '打开这一版存档' : (look ? '仍然打开原网页（小心）' : e.code === 'login' ? '用 Safari 窗口打开（在里面登录）' : '打开原网页'), pri && !look, e.code === 'login' || d.noFrame ? ' data-ext="1"' : '');   // 疑似仿冒的网站：不把“打开原网页”放第一个
  const srch = (label, pri) => q ? b('rd-search', label || '搜索「' + q + '」', pri, ' data-q="' + esc(q) + '"') : '';
  let tip = '', btns = '';
  switch (e.code) {
    case 'nohost': tip = '网址可能打错了，或者这个网站已经关了';
      btns = (look ? b('rd-goto', '你要找的是' + look.n + '吗？去 ' + look.d, true, ' data-u="https://' + esc(look.d) + '/"') : '') + srch('', !look) + arch(false); break;
    case 'gone': tip = '原网页被删了，互联网档案馆里可能还留着以前的版本'; btns = arch(true) + srch(d.t ? '搜这个标题，看别处有没有转载' : '', false) + orig(false); break;
    case 'login': tip = '要登录才能看的网站：用 Safari 窗口打开，在里面登录一次'; btns = orig(true) + (d.noFrame ? '' : b('rd-orig', '在 App 里打开原网页', false)) + arch(false); break;
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
  paintTts();
  if (W.shownRead === t && !d.dirty) return;
  W.shownRead = t; d.dirty = false; findReset();
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
      const old = d.cachedAt && (d.stale || Date.now() - d.cachedAt > 30 * 60000);
      const cacheNote = old ? '<div class="ws-cache"><span>' + (d.stale ? '网络不好，' : '') + '显示的是 ' + esc(whenCn(d.cachedAt)) + ' 存在手机里的版本</span><button type="button" data-act="rd-refresh">取最新的</button></div>' : '';
      box.innerHTML = '<article class="ws-art" style="font-size:' + W.fs + 'px">' + banners(d, a.u) + arch + '<div class="ws-trb" hidden></div>' +
        '<h1>' + esc(a.title) + '</h1><div class="ws-ot" hidden></div><div class="meta">' + esc([a.site, a.date, '约 ' + mins + ' 分钟读完'].filter(Boolean).join(' · ')) + '</div>' + cacheNote +
        (a.img ? '<img class="ws-lead" src="' + esc(a.img) + '" alt="" referrerpolicy="no-referrer">' : '') + '<div class="ws-body"></div>' + from + '</article>';
      box.querySelector('.ws-body').appendChild(sanitize(a.html));
      restorePos(t);
    }
    findReset();
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
  let next = 0, stop = false;
  const one = async bt => {
    const r = await B.call({ op: 'translate', html: true, items: bt.map(u => u.html) }, 90000);
    if (account !== accountRevision || tr.gen !== gen) { stop = true; return false; }   // 页面重画过了：这批结果交给新的那一轮
    if (!r || !r.ok) { tr.err = r || { code: 'net', msg: '翻译出错了' }; stop = true; return true; }
    bt.forEach((u, k) => { const s = r.items && r.items[k]; if (s) { if (W.trc.size > 4000) W.trc.clear(); W.trc.set(u.html, s); if (tr.on) applyUnit(u); tr.done++; } else tr.failed++; });
    (r.why || []).forEach(w => { if (tr.why.indexOf(w) < 0) tr.why.push(w); });
    trBar(t); return true;
  };
  if (!(await one(batches[next++])) ) return;   // 标题和开头几段先翻，几秒就能看到
  const worker = async () => { while (!stop && next < batches.length) { if (!(await one(batches[next++]))) return false; } return true; };
  const res = await Promise.all([worker(), worker()]);   // 后面的两批同时翻（以前一批翻完才发下一批，长文章要等很久）
  if (res.some(x => x === false) && (account !== accountRevision || tr.gen !== gen)) return;
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
  const page = top();
  let en = W.trc.get('en|' + c.q);
  if (!en) {
    B.toast('正在把搜索词翻成英文…');
    const r = await B.call({ op: 'translate', to: 'en', items: [c.q] }, 30000);
    if (W.cur !== c || top() !== page) return;
    if (!r || !r.ok || !r.items || !r.items[0]) { B.toast((r && r.msg) || '没翻成英文，稍后再试'); return; }
    en = String(r.items[0]).replace(/^["'“”‘’]+|["'“”‘’。.]+$/g, '').replace(/\s+/g, ' ').trim().slice(0, 200);
    W.trc.set('en|' + c.q, en);
  }
  if (W.cur === c && top() === page) search(en, c.type === 'images' ? 'web' : c.type, '', c.q);
}
async function fetchRead(t) {
  const account = accountRevision, d = t.d, at = d.at || '', force = !!d.force; d.loading = true; d.force = false;
  const c = force ? null : await artGet(d.u, at);
  if (account !== accountRevision) return;
  // 手机里存着的直接用（不联网、不花服务器次数）：收藏的、固定日期的存档、6 小时内看过的
  if (c && c.art && (isFav(d.u, c.art.arch || at) || (at && at !== 'latest') || Date.now() - c.tm < 6 * 3600000)) {
    d.loading = false; d.dirty = true; d.art = c.art; d.cachedAt = c.tm; d.stale = false; addSeen(d);
    if (top() === t) renderRead(t);
    return;
  }
  const r = await B.call({ op: 'read', url: d.u, at: at }, d.at ? 45000 : 25000);
  if (account !== accountRevision) return;
  d.loading = false; d.dirty = true;
  if (r && r.ok) { d.art = r; d.cachedAt = 0; d.stale = false; addSeen(d); artPut(d.u, at, r); }
  else if (c && c.art && (!r || /^(net|timeout|down|busy|limit)$/.test(r.code || 'net'))) { d.art = c.art; d.cachedAt = c.tm; d.stale = true; addSeen(d); }   // 网不好：先给手机里存着的旧版本
  else d.err = r || { code: 'net', msg: '出错了' };
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
  im.onerror = () => { if (!tried && it.th && im.src !== it.th) { tried = 1; im.src = it.th; return; } box.innerHTML = '<p>图片加载不出来，可以点下面用 Safari 窗口看原图</p>'; };
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
  const h = '<div class="ws-sec" style="margin-top:10px">打开网页</div><div class="ws-card">' +
    '<div class="ws-row" data-act="pref-open" style="cursor:pointer"><span class="ws-tx" style="white-space:normal">打开网页的方式<span class="ws-sub" style="white-space:normal">自动：能放进 Chatter、又做了手机适配的网页直接显示；其余（大网站、电脑版网页、视频网站）用 iPhone 自带的 Safari 窗口打开原网站，点“完成”回来。简洁阅读随时在“⋯”里</span></span><span class="ws-val">' + ({ sheet: 'Safari 窗口', read: '简洁阅读' }[P.open] || '自动') + '</span>' + ico(I.chev, 16) + '</div></div>' +
    '<div class="ws-sec">排序和过滤</div><div class="ws-card">' +
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
    '<div class="ws-sec">浏览记录和手机里的文章</div><div class="ws-card">' +
      sw('tgl-nohist', !!P.noHist, '不记浏览记录', '打开以后不记看过的网页和搜过的词；已经记下的去“浏览记录”里删') +
      '<div class="ws-row" data-act="hist" style="cursor:pointer"><span class="ws-tx">浏览记录<span class="ws-sub">只存在这台手机里，退出登录会清掉</span></span><span class="ws-val">' + seen().length + ' 条</span>' + ico(I.chev, 16) + '</div>' +
      '<div class="ws-row" data-act="art-wipe" style="cursor:pointer"><span class="ws-tx" style="white-space:normal">清空手机里保存的文章<span class="ws-sub" style="white-space:normal">用简洁阅读看过的文章会在手机里存一份：收藏的没网也能看，再打开不用等</span></span><span class="ws-val" data-r="artn">…</span></div></div>' +
    '<div class="ws-sec">置顶网站</div><div class="ws-card">' + list('pin', '还没有') + '</div>' +
    '<div class="ws-sec">不看的网站</div><div class="ws-card">' + list('block', '还没有') + '</div>' +
    '<div class="ws-sec">默认名单</div><div class="ws-card">' +
      '<details><summary>营销号（' + CFG.farms.length + ' 个）</summary><p>' + esc(CFG.farms.join('、')) + '</p></details>' +
      '<details><summary>干净网站（' + CFG.clean.length + ' 个）</summary><p>' + esc(CFG.clean.join('、')) + '</p></details>' +
      '<details><summary>要登录的网站（' + CFG.direct.length + ' 个）</summary><p>这些网站不让在 App 里显示时，直接用 Safari 窗口打开（在里面登录一次）。' + esc(CFG.direct.join('、')) + '</p></details></div>' +
    '<div class="ws-hint">你的规则存在账号里，换手机也在。默认名单在数据库里，改了不用更新 App。</div>';
  R('rules').innerHTML = h;
  const countLabel = R('artn');
  artCount().then(n => { if (countLabel.isConnected) countLabel.textContent = n == null ? '' : n + ' 篇'; });
}
function addSite(k) {
  B.form(k === 'pin' ? '置顶网站' : '不看的网站', [{ ph: '网址，例如 github.com', max: 120, type: 'url' }], async vals => {
    const d = normSite(vals[0]); if (!d) return '网址不对，例如 github.com';
    P[k] = [d].concat((P[k] || []).filter(x => x !== d)).slice(0, 60);
    const other = k === 'pin' ? 'block' : 'pin'; P[other] = (P[other] || []).filter(x => x !== d);
    savePrefs(); renderTop(); return null;
  }, '添加');
}

/* ---------- 浏览记录（只存在这台手机，按账号分开；打开“不记浏览记录”就什么都不记） ---------- */
const HIST_MAX = 300;
function addVisit(v) {   // v：{ u 网址, t 标题, s 网站, at 存档时间, m 'web' 原网页 / 'read' 简洁阅读 }
  if (!v || !v.u || (P && P.noHist)) return;
  const at = v.at || '', all = seen(), old = all.find(x => x.u === v.u && (x.at || '') === at), list = all.filter(x => x !== old);
  list.unshift({ u: v.u, t: v.t || (old && old.t) || '', s: v.s || host(v.u), at: at, m: v.m || 'read', tm: Date.now(), c: ((old && old.c) || 1) + (old ? 1 : 0) });
  LSs(uidKey('ch2wsSeen'), list.slice(0, HIST_MAX));
}
function openEntry(x) {   // 记录、收藏、联想里点一条：存档回存档，原网页回原网页，简洁阅读回简洁阅读
  if (!x || !x.u) return;
  if (x.at) go('read', { u: x.u, t: x.t, at: x.at });
  else if (x.m === 'web') openUrl(x.u, x.t);
  else go('read', { u: x.u, t: x.t });
}
const dayStart = tm => { const d = new Date(tm); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };
const hm = tm => { const d = new Date(tm); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };
function dayLabel(tm) {
  const d0 = dayStart(Date.now()), x = dayStart(tm), d = new Date(tm);
  if (x === d0) return '今天';
  if (x === d0 - 86400000) return '昨天';
  return (d.getMonth() + 1) + ' 月 ' + d.getDate() + ' 日' + (d.getFullYear() !== new Date().getFullYear() ? '（' + d.getFullYear() + ' 年）' : '');
}
function whenCn(tm) { const l = dayLabel(tm); return l === '今天' || l === '昨天' ? l + ' ' + hm(tm) : l; }
function entrySub(x, full) { return [x.s || host(x.u), x.at ? tsDay(x.at) + ' 存档' : '', full && x.tm ? hm(x.tm) : '', full ? (x.m === 'web' ? '原网页' : '简洁阅读') : ''].filter(Boolean).join(' · '); }
function oftenSites() {   // 常去的网站：浏览记录里去过 2 次以上的网站，置顶过的不重复放
  const n = {}, first = {};
  seen().forEach((x, i) => { const h = bare(host(x.u)); if (!h) return; n[h] = (n[h] || 0) + (x.c || 1); if (!(h in first)) first[h] = i; });
  const pinned = h => (P.pin || []).some(d => { const p = d.split('/')[0]; return h === p || h.endsWith('.' + p); });
  return Object.keys(n).filter(h => n[h] >= 2 && !pinned(h)).sort((a, b) => n[b] - n[a] || first[a] - first[b]).slice(0, 5).map(h => ({ h: h, n: n[h] }));
}
function renderHistory() {
  if (!root) return;
  const all = seen(), q = String(W.flt.hist || '').trim().toLowerCase();
  const list = all.map((x, i) => [x, i]).filter(p => !q || ((p[0].t || '') + ' ' + p[0].u).toLowerCase().indexOf(q) >= 0);
  let h = P.noHist ? '<div class="ws-note2">现在不记浏览记录。想重新开始记，去搜索规则里关掉“不记浏览记录”。</div>' : '';
  if (!all.length) h += '<div class="ws-empty">还没有浏览记录。<br>打开过的网页和文章会记在这里，只存在这台手机。</div>';
  else if (!list.length) h += '<div class="ws-empty">没有找到「' + esc(q) + '」</div>';
  else {
    let day = null;
    list.forEach(p => {
      const x = p[0], i = p[1], dl = x.tm ? dayLabel(x.tm) : '更早';
      if (dl !== day) { h += (day === null ? '' : '</div>') + '<div class="ws-day">' + esc(dl) + '</div><div class="ws-card">'; day = dl; }
      h += '<div class="ws-row" data-act="seen-go" data-i="' + i + '" style="cursor:pointer">' + ico(x.m === 'web' ? I.globe : I.read, 17) + '<span class="ws-tx">' + esc(x.t || host(x.u) || x.u) + '<span class="ws-sub">' + esc(entrySub(x, true)) + '</span></span>' +
        '<button type="button" class="ws-x" data-act="seen-del" data-i="' + i + '" aria-label="删掉这条">' + ico(I.x, 15) + '</button></div>';
    });
    h += '</div><div class="ws-hint">只存在这台手机里，最多记 ' + HIST_MAX + ' 条，退出登录会清掉。</div>';
  }
  R('hist').innerHTML = h;
}

/* ---------- 收藏（存在账号里，换手机也在） ---------- */
function isFav(u, at) { return ((P && P.fav) || []).some(f => f.u === u && (f.at || '') === (at || '')); }
function toggleFav(x) {   // 收藏 / 取消收藏；返回 true 表示现在是收藏着的
  const at = x.at || '', same = f => f.u === x.u && (f.at || '') === at, had = (P.fav || []).some(same);
  P.fav = had ? P.fav.filter(f => !same(f)) : [{ u: x.u, t: x.t || host(x.u), s: x.s || host(x.u), at: at, tm: Date.now() }].concat(P.fav || []).slice(0, 200);
  savePrefs(); return !had;
}
function renderFavs() {
  if (!root) return;
  const all = P.fav || [], q = String(W.flt.favs || '').trim().toLowerCase();
  const list = all.map((f, i) => [f, i]).filter(p => !q || ((p[0].t || '') + ' ' + p[0].u + ' ' + (p[0].s || '')).toLowerCase().indexOf(q) >= 0);
  let h;
  if (!all.length) h = '<div class="ws-empty">还没有收藏。<br>看文章、看网页时点“收藏”，就会出现在这里；换手机登录也在。</div>';
  else if (!list.length) h = '<div class="ws-empty">没有找到「' + esc(q) + '」</div>';
  else h = '<div class="ws-card" style="margin-top:8px">' + list.map(p => { const f = p[0], i = p[1];
    return '<div class="ws-row" data-act="fav-go" data-i="' + i + '" style="cursor:pointer">' + ico(I.mark, 17) + '<span class="ws-tx">' + esc(f.t || host(f.u) || f.u) + '<span class="ws-sub">' + esc([f.s || host(f.u), f.tm ? whenCn(f.tm) + ' 收藏' : ''].filter(Boolean).join(' · ')) + '</span></span>' +
      '<button type="button" class="ws-x" data-act="fav-del" data-i="' + i + '" aria-label="取消收藏">' + ico(I.x, 15) + '</button></div>'; }).join('') + '</div>' +
    '<div class="ws-hint">收藏存在账号里，换手机也在。在简洁阅读里收藏的文章，手机里还存了一份，没网也能看。</div>';
  R('favs').innerHTML = h;
}

/* ---------- 输入时的联想：搜过的词、收藏和看过的网页、置顶网站（全在手机里找，不联网、不花次数） ---------- */
function sugList(q) {
  q = String(q || '').replace(/\s+/g, ' ').trim(); if (!q) return [];
  const lq = q.toLowerCase(), out = [], keys = new Set();
  if (URLISH.test(q) && q.indexOf(' ') < 0) out.push({ k: 'url', v: /^https?:/i.test(q) ? q : 'https://' + q, t: '打开 ' + q.replace(/^https?:\/\//i, ''), s: '直接打开这个网址' });
  hist().filter(x => x !== q && x.toLowerCase().indexOf(lq) >= 0).slice(0, 4).forEach(x => out.push({ k: 'q', v: x, t: x }));
  const pages = (P.fav || []).map(f => Object.assign({ fav: 1, m: f.at ? 'read' : 'web' }, f)).concat(seen());
  let np = 0;
  for (const p of pages) {
    if (np >= 4) break;
    const key = p.u + '|' + (p.at || '');
    if (keys.has(key) || ((p.t || '') + ' ' + p.u).toLowerCase().indexOf(lq) < 0) continue;
    keys.add(key); np++;
    out.push({ k: p.fav ? 'fav' : 'page', p: p, t: p.t || host(p.u) || p.u, s: (p.fav ? '收藏 · ' : '看过 · ') + (p.s || host(p.u)) });
  }
  if (!/^site:/i.test(q)) (P.pin || []).filter(d => d.toLowerCase().indexOf(lq) >= 0).slice(0, 2).forEach(d => out.push({ k: 'site', v: d, t: '只搜 ' + d, s: '置顶网站' }));
  return out.slice(0, 9);
}
function sugShow(form, q) {
  if (!root) return;
  const box = R('sug-' + form); if (!box) return;
  const list = sugList(q); W.sug = list;
  if (!list.length) { box.hidden = true; box.innerHTML = ''; return; }
  const icon = { url: I.out, q: I.clock, fav: I.mark, site: I.find };
  box.innerHTML = list.map((x, i) => '<div class="ws-row" data-act="sug" data-i="' + i + '">' + ico(x.k === 'page' ? (x.p.m === 'web' ? I.globe : I.read) : icon[x.k], 17) +
    '<span class="ws-tx">' + esc(x.t) + (x.s ? '<span class="ws-sub">' + esc(x.s) + '</span>' : '') + '</span></div>').join('');
  box.hidden = false;
}
function sugHide() { if (!root) return; ['home', 'res'].forEach(f => { const b = R('sug-' + f); if (b && !b.hidden) { b.hidden = true; b.innerHTML = ''; } }); }

/* ---------- 简洁阅读里查找 ---------- */
function findOpen() {
  const bar = R('find'); if (!bar) return;
  bar.hidden = false;
  const inp = bar.querySelector('input');
  setTimeout(() => { try { inp.focus(); inp.select(); } catch (e) {} }, 30);
  if (inp.value.trim()) findRun(inp.value);
}
function findClear() {
  (W.fnd.marks || []).forEach(m => { const p = m.parentNode; if (!p) return; p.replaceChild(document.createTextNode(m.textContent), m); p.normalize(); });
  W.fnd = { q: '', marks: [], i: -1 };
}
function findReset() {
  if (!root) return;
  clearTimeout(W.fndT); findClear();
  const bar = R('find'); if (bar) { bar.hidden = true; const inp = bar.querySelector('input'); if (inp) inp.value = ''; }
  const c = R('fcount'); if (c) c.textContent = '';
}
function findRun(q) {
  findClear(); q = String(q || '').trim(); W.fnd.q = q;
  const art = R('read').querySelector('.ws-art'), cnt = R('fcount');
  if (!q || !art) { cnt.textContent = ''; return; }
  const lq = q.toLowerCase(), nodes = [];
  const wk = document.createTreeWalker(art, NodeFilter.SHOW_TEXT, { acceptNode: n => (n.nodeValue.toLowerCase().indexOf(lq) >= 0 && n.parentNode && !n.parentNode.closest('[hidden],button,.ws-trb,.ws-cache,.ws-arch')) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT });
  while (wk.nextNode()) nodes.push(wk.currentNode);
  const marks = [];
  for (const n of nodes) {
    const s = n.nodeValue, ls = s.toLowerCase(), frag = document.createDocumentFragment();
    let from = 0, k;
    while ((k = ls.indexOf(lq, from)) >= 0 && marks.length < 999) {
      if (k > from) frag.appendChild(document.createTextNode(s.slice(from, k)));
      const m = document.createElement('mark'); m.className = 'ws-hl'; m.textContent = s.slice(k, k + lq.length);
      frag.appendChild(m); marks.push(m); from = k + lq.length;
    }
    if (from < s.length) frag.appendChild(document.createTextNode(s.slice(from)));
    n.parentNode.replaceChild(frag, n);
  }
  W.fnd.marks = marks; W.fnd.i = marks.length ? 0 : -1;
  findShow();
}
function findStep(dir) {
  const f = W.fnd, n = f.marks.length;
  if (!n) { const inp = R('find').querySelector('input'); if (inp && inp.value.trim()) findRun(inp.value); return; }
  f.i = (f.i + dir + n) % n; findShow();
}
function findShow() {
  const f = W.fnd;
  f.marks.forEach((m, i) => m.classList.toggle('cur', i === f.i));
  R('fcount').textContent = f.q ? (f.marks.length ? (f.i + 1) + '/' + f.marks.length : '没找到') : '';
  const m = f.marks[f.i]; if (m) { try { m.scrollIntoView({ block: 'center' }); } catch (e) {} }
}

/* ---------- 朗读：用手机自带的语音，不联网、不花钱 ---------- */
const TTS = { on: false, q: [], i: 0, t: null };
const ttsOk = () => typeof window.speechSynthesis !== 'undefined' && typeof window.SpeechSynthesisUtterance !== 'undefined';
function paintTts() {
  const tool = root && R('rtool'), b = tool && tool.querySelector('[data-act="rd-say"]'); if (!b) return;
  b.classList.toggle('on', TTS.on); b.innerHTML = ico(TTS.on ? I.stop : I.speak) + (TTS.on ? '停止' : '朗读');
}
function ttsStop() {
  if (!TTS.on) return;
  TTS.on = false; TTS.q = []; TTS.t = null;
  try { window.speechSynthesis.cancel(); } catch (e) {}
  if (root) root.querySelectorAll('.ws-say').forEach(x => x.classList.remove('ws-say'));
  paintTts();
}
function ttsStart(t) {
  if (!ttsOk()) { B.toast('这台手机的浏览器不支持朗读'); return; }
  const art = R('read').querySelector('.ws-art'); if (!art || !t.d.art) { B.toast('文章还没打开'); return; }
  const els = Array.from(art.querySelectorAll('h1, .ws-body p, .ws-body li, .ws-body h2, .ws-body h3, .ws-body h4, .ws-body blockquote, .ws-body pre, .ws-body figcaption, .ws-body td, .ws-body dd'))
    .filter(el => el.textContent.trim() && !el.closest('[hidden]') && !el.querySelector('p, li, blockquote'));
  if (!els.length) { B.toast('这一页没有能朗读的文字'); return; }
  const top0 = R('rdsc').getBoundingClientRect().top + 8;
  let i = els.findIndex(el => el.getBoundingClientRect().bottom > top0); if (i < 0) i = 0;   // 从屏幕上正在看的那一段开始读
  try { window.speechSynthesis.cancel(); } catch (e) {}
  TTS.on = true; TTS.q = els; TTS.i = i; TTS.t = t; paintTts();
  B.toast('开始朗读（用手机自带的声音，不联网）');
  speakNext();
}
function speakNext() {
  if (!TTS.on) return;
  if (top() !== TTS.t) { ttsStop(); return; }
  const el = TTS.q[TTS.i];
  if (!el || !el.isConnected) { const end = !el; ttsStop(); if (end) B.toast('读完了'); return; }
  root.querySelectorAll('.ws-say').forEach(x => x.classList.remove('ws-say')); el.classList.add('ws-say');
  const r = el.getBoundingClientRect(), sr = R('rdsc').getBoundingClientRect();
  if (r.top < sr.top || r.bottom > sr.bottom) { try { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) {} }
  const text = el.textContent.replace(/\s+/g, ' ').trim().slice(0, 2500);
  const u = new window.SpeechSynthesisUtterance(text);
  u.lang = !foreign(text) ? 'zh-CN' : /[぀-ヿ]/.test(text) ? 'ja-JP' : /[가-힯]/.test(text) ? 'ko-KR' : 'en-US';
  const my = TTS.i;
  u.onend = () => { if (TTS.on && TTS.i === my) { TTS.i++; speakNext(); } };
  u.onerror = ev => { if (!TTS.on || TTS.i !== my || (ev && /interrupted|canceled/.test(ev.error || ''))) return; TTS.i++; speakNext(); };
  try { window.speechSynthesis.speak(u); } catch (e) { ttsStop(); B.toast('朗读没能开始'); }
}

/* ---------- 阅读位置：再打开同一篇，回到上次看到的地方（只存在这台手机） ---------- */
const posKey = d => d.u + '|' + (d.at || '');
function savePos() {
  const t = top(); if (!t || t.v !== 'read' || !t.d.art || t.d.art.kind === 'links' || !t.d.posReady || (P && P.noHist)) return;
  const sc = R('rdsc'), max = sc.scrollHeight - sc.clientHeight; if (max < 300) return;
  const r = sc.scrollTop / max, m = LSg(uidKey('ch2wsPos'), {}), k = posKey(t.d);
  delete m[k]; if (r > 0.04 && r < 0.96) m[k] = Math.round(r * 1000) / 1000;
  const ks = Object.keys(m); ks.slice(0, Math.max(0, ks.length - 150)).forEach(x => delete m[x]);
  LSs(uidKey('ch2wsPos'), m);
}
function restorePos(t) {
  const d = t.d;
  if (d.posTried) { d.posReady = true; return; }
  d.posTried = true;
  const r = LSg(uidKey('ch2wsPos'), {})[posKey(d)];
  if (!r || t.y != null) { d.posReady = true; return; }
  setTimeout(() => {
    if (top() === t) { const sc = R('rdsc'), max = sc.scrollHeight - sc.clientHeight; if (max > 300) { sc.scrollTop = Math.round(r * max); B.toast('接着上次看到的地方'); } }
    d.posReady = true;
  }, 60);
}

/* ---------- 手机里保存的文章（IndexedDB）：收藏的没网也能看，6 小时内看过的再打开不用等、不花服务器次数 ---------- */
const ADB = { p: null, db: null }, ART_MAX = 120;
function adb() {
  if (ADB.p) return ADB.p;
  const revision = accountRevision;
  const opening = new Promise((res, rej) => {
    if (!window.indexedDB) { rej(new Error('no indexeddb')); return; }
    let r; try { r = indexedDB.open('chatter-ws', 1); } catch (e) { rej(e); return; }
    r.onupgradeneeded = () => { const db = r.result; if (!db.objectStoreNames.contains('art')) db.createObjectStore('art', { keyPath: 'k' }).createIndex('tm', 'tm'); };
    r.onsuccess = () => { const db = r.result;
      if (revision !== accountRevision || ADB.p !== opening) { db.close(); rej(new Error('账号已切换')); return; }
      ADB.db = db; db.onversionchange = () => { try { db.close(); } catch (e) {} if (ADB.db === db) { ADB.db = null; ADB.p = null; } }; res(db); };   // 退出登录要删掉整个库时，先让开
    r.onerror = () => rej(r.error || new Error('indexeddb'));
    r.onblocked = () => rej(new Error('indexeddb blocked'));
  });
  ADB.p = opening;
  opening.catch(() => { if (ADB.p === opening) ADB.p = null; });
  return opening;
}
const artK = (uid, u, at) => uid + '|' + (at || '') + '|' + u;
const articleRange = uid => IDBKeyRange.bound(uid + '|', uid + '}', false, true);
const idbReq = q => new Promise((res, rej) => { q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
async function artGet(u, at) {
  const uid = B.uid();
  if (!uid) return null;
  try { const db = await adb(); return (await idbReq(db.transaction('art').objectStore('art').get(artK(uid,u,at)))) || null; } catch (e) { return null; }
}
async function artPut(u, at, art) {
  const uid = B.uid(), revision = accountRevision;
  if (!uid || !art || !art.ok || String(art.html || '').length > 1500000) return;
  if (P && P.noHist && !isFav(u, art.arch || at || '')) return;   // 不记浏览记录时，只存收藏的
  try {
    const db = await adb();
    if (uid !== B.uid() || revision !== accountRevision) return;
    const keep = new Set(((P && P.fav) || []).map(f => artK(uid, f.u, f.at || '')));
    await new Promise((res, rej) => {
      const tx = db.transaction('art', 'readwrite'), st = tx.objectStore('art');
      st.put({ k: artK(uid,u,at), uid, u: u, at: at || '', art: art, tm: Date.now() });
      const cq = st.count(articleRange(uid));
      cq.onsuccess = () => {   // 超过 120 篇：从最早存的删起，收藏的留着
        let extra = cq.result - ART_MAX; if (extra <= 0) return;
        const cur = st.index('tm').openKeyCursor();
        cur.onsuccess = () => { const c = cur.result; if (!c || extra <= 0) return; if (c.primaryKey.startsWith(uid + '|') && !keep.has(c.primaryKey)) { st.delete(c.primaryKey); extra--; } c.continue(); };
      };
      tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error);
    });
  } catch (e) { try { B.logErr('ws-art', e); } catch (x) {} }
}
async function artCount() {
  const uid = B.uid(); if (!uid) return 0;
  try { const db = await adb(); return await idbReq(db.transaction('art').objectStore('art').count(articleRange(uid))); } catch (e) { return null; }
}
async function clearMyArticles() {
  const uid = B.uid(), revision = accountRevision;
  if (!uid) return;
  B.acts('清空当前账号在这台设备保存的文章？', [{ label: '清空', danger: true, fn: async () => {
    try {
      const db = await adb();
      if (revision !== accountRevision) return;
      await new Promise((res, rej) => {
        const tx = db.transaction('art', 'readwrite'); tx.objectStore('art').delete(articleRange(uid));
        tx.oncomplete = res; tx.onabort = tx.onerror = () => rej(tx.error);
      });
      if (revision === accountRevision) { renderTop(); B.toast('本账号在这台设备保存的文章已清空'); }
    } catch (e) { if (revision === accountRevision) B.toast('本机文章清理失败，请重试'); }
  } }, { label: '取消', fn: null }]);
}
function artClose() { const db = ADB.db; ADB.db = null; ADB.p = null; if (db) { try { db.close(); } catch (e) {} } }

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
    case 'seen-go': { const s = seen()[+el.dataset.i]; if (s) openEntry(s); break; }
    case 'seen-del': { e.stopPropagation(); const s = seen()[+el.dataset.i]; if (s) LSs(uidKey('ch2wsSeen'), seen().filter(x => x !== s && !(x.u === s.u && (x.at || '') === (s.at || '')))); renderHistory(); break; }
    case 'seen-wipe': if (seen().length) B.acts('清空全部浏览记录？', [{ label: '清空', danger: true, fn: () => { LSs(uidKey('ch2wsSeen'), []); LSs(uidKey('ch2wsPos'), {}); renderTop(); B.toast('浏览记录清空了'); } }, { label: '取消', fn: null }]); break;
    case 'favs': W.flt.favs = ''; go('favs'); { const i = V('favs').querySelector('input'); if (i) i.value = ''; } break;
    case 'hist': W.flt.hist = ''; go('hist'); { const i = V('hist').querySelector('input'); if (i) i.value = ''; } break;
    case 'fav-del': { e.stopPropagation(); const f = (P.fav || [])[+el.dataset.i]; if (f) { P.fav = P.fav.filter(x => x !== f); savePrefs(); renderFavs(); B.toast('已取消收藏'); } break; }
    case 'often-go': openUrl('https://' + el.dataset.d + '/', el.dataset.d); break;
    case 'sug': { const x = W.sug[+el.dataset.i], inp = el.closest('.ws-v').querySelector('.ws-field input'); sugHide(); if (!x) break; try { inp.blur(); } catch (z) {}
      if (x.k === 'url') openUrl(x.v); else if (x.k === 'q') { inp.value = x.v; search(x.v, W.type); } else if (x.k === 'site') { inp.value = 'site:' + x.v + ' '; inp.closest('.ws-field').classList.add('has'); inp.focus(); } else openEntry(x.p);
      break; }
    case 'tgl-nohist': P.noHist = !P.noHist; savePrefs(); renderTop(); B.toast(P.noHist ? '以后不记浏览记录和搜过的词' : '以后会记浏览记录'); break;
    case 'art-wipe': clearMyArticles(); break;
    case 'rd-find': findOpen(); break;
    case 'find-next': findStep(1); break;
    case 'find-prev': findStep(-1); break;
    case 'find-x': findReset(); break;
    case 'rd-say': if (TTS.on) ttsStop(); else if (t && t.v === 'read') ttsStart(t); break;
    case 'rd-refresh': if (t && t.v === 'read') { t.d.art = null; t.d.err = null; t.d.force = true; t.d.dirty = true; renderRead(t); } break;
    case 'web-url': if (t && t.v === 'web') {
      const d = t.d, u = d.src || d.u;
      B.acts(u.length > 90 ? u.slice(0, 88) + '…' : u, [
        { label: '复制网址', fn: () => B.copy(u) },
        { label: '修改网址', fn: () => B.form('修改网址', [{ ph: '网址', val: u, max: 2000, type: 'url' }], async vals => { const v = String(vals[0] || '').trim(); if (!v) return '网址不能是空的'; leaveWeb(() => search(v, 'web')); return null; }, '打开') },
        { label: isFav(d.u, '') ? '取消收藏' : '收藏这个网页', fn: () => { const on = toggleFav({ u: d.u, t: d.t || host(u), s: host(u) }); B.toast(on ? '已收藏，在搜索首页的“收藏”里' : '已取消收藏'); } },
        { label: '取消', fn: null }
      ]);
    } break;
    case 'pin-add': addSite('pin'); break;
    case 'pin-go': { const inp = V('home').querySelector('input'); inp.value = 'site:' + el.dataset.d + ' '; inp.closest('.ws-field').classList.add('has'); inp.focus(); break; }
    case 'fav-go': { const f = (P.fav || [])[+el.dataset.i]; if (f) { if (f.at || navigator.onLine === false) go('read', { u: f.u, t: f.t, at: f.at || '' }); else openUrl(f.u, f.t); } break; }
    case 'fav-all': W.flt.favs = ''; go('favs'); break;
    case 'r-go': if (it && it.u) { if (it.ext) openSheet(it.u, it.t); else openUrl(it.u, it.t); } break;
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
    case 'vid-go': if (it && it.u) { const vid = vidOf(it.u); if (vid) go('vid', { u: it.u, t: it.t, vid: vid }); else openSheet(it.u, it.t); } break;
    case 'vid-out': if (t && t.d.u) openSheet(t.d.u, t.d.t); break;
    case 'vid-send': if (t && t.d.u) B.forward((t.d.t ? t.d.t + '\n' : '') + t.d.u); break;
    case 'rd-orig': if (t && t.d.u) { if (t.d.noFrame || el.dataset.ext) ext(archUrl(t.d)); else openOrig(archUrl(t.d), (t.d.art && t.d.art.title) || t.d.t, { fromRead: true }); } break;
    case 'rd-ext': if (t && t.d.u) ext(archUrl(t.d)); break;
    case 'web-close': leaveWeb(); break;
    case 'web-tipx': R('wtip').hidden = true; break;
    case 'web-ext': if (t && t.d.u) openSheet((t.d.fail && t.d.fail.url) || t.d.src || t.d.u, t.d.t); break;
    case 'web-sheet': if (t && t.v === 'web') { const d = t.d, u = (d.fail && d.fail.url) || d.src || d.u; addVisit({ u: d.u, t: d.t, s: host(u), m: 'web' }); if (standalone()) leaveWeb(() => { show(); ext(u); }); else ext(u); } break;
    case 'web-read': if (t && t.v === 'web') { const d = t.d; leaveWeb(() => go('read', { u: d.u, t: d.t, noFrame: !!d.fail })); } break;
    case 'web-more': if (t && t.v === 'web') {
      const d = t.d, u = d.src || d.u;
      B.acts(host(u), [
        { label: '简洁阅读（能翻译、调字号）', fn: () => leaveWeb(() => go('read', { u: d.u, t: d.t, noFrame: !!d.fail })) },
        { label: isFav(d.u, '') ? '取消收藏' : '收藏这个网页', fn: () => { const on = toggleFav({ u: d.u, t: d.t || host(u), s: host(u) }); B.toast(on ? '已收藏，在搜索首页的“收藏”里' : '已取消收藏'); } },
        { label: '重新加载', fn: () => { if (d.src) { R('wbox').dataset.src = ''; d.loads = 0; show(); } } },
        { label: '复制链接', fn: () => B.copy(u) },
        { label: '发给好友', fn: () => B.forward((d.t ? d.t + '\n' : '') + u) },
        { label: '用 Safari 窗口打开', fn: () => leaveWeb(() => { show(); openSheet(u, d.t); }) },
        { label: '取消', fn: null }
      ]);
    } break;
    case 'pref-open': B.acts('打开网页的方式', [['', '自动（推荐）：能放进 Chatter 的直接显示，其余用 Safari 窗口'], ['sheet', '总是用 Safari 窗口'], ['read', '先用简洁阅读（能翻译、省流量）']].map(x => ({ label: x[1] + ((P.open || '') === x[0] ? ' ✓' : ''), fn: () => { P.open = x[0]; savePrefs(); renderTop(); } })).concat([{ label: '取消', fn: null }])); break;
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
      const at = t.d.art.arch || '', on = toggleFav({ u: t.d.u, t: t.d.art.title, s: t.d.art.site + (at ? ' · ' + tsDay(at) + ' 存档' : ''), at: at });
      if (on) artPut(t.d.u, at || t.d.at || '', t.d.art);   // 收藏的文章在手机里存一份：没网也能看
      t.d.dirty = false; renderRead(t); B.toast(on ? '已收藏，没网也能看；在搜索首页的“收藏”里' : '已取消收藏'); break;
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

window.ChatterSearch = { open: open, openPage: openPage, onPop: onPop, isOpen: () => W.on, closeNow: close, resetAccount, _w: W, _hit: hit, _arrange: arrange, _sanitize: sanitize, _vidOf: vidOf, _lookAlike: lookAlike, _foreign: foreign, _jumped: jumped, _unpack: unpack, _pack: packUnit, _sugList: sugList, _oftenSites: oftenSites, _artGet: artGet };
})();
