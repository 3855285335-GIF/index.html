// 检查：网页内置的中转列表（src/app.js 的 TURN_DEFAULT）和 SQL 里的两份（3-setup-v5.sql、update-turn.sql）完全一致，
// 并且没有任何一家在 ExpressTURN 之外提供 UDP 地址（浏览器按协议选中转：UDP 2 > TCP 1 > TLS 0）。
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'src', 'app.js'), 'utf8');
const m = src.match(/const TURN_DEFAULT = (\[[\s\S]*?\n\]);/);
const builtin = new Function('return ' + m[1])();
const fromSql = f => { const s = fs.readFileSync(path.join(root, 'sql', f), 'utf8'); const i = s.indexOf("values ('ice', '") + 16; const j = s.slice(i, s.indexOf("'::jsonb)", i)); return JSON.parse(j).turn; };
const norm = l => JSON.stringify(l.map(p => ({ name: p.name, username: p.username, credential: p.credential, urls: p.urls })));
let fails = 0; const ok = (c, t) => { console.log((c ? 'PASS ' : 'FAIL ') + t); if (!c) fails++; };
for (const f of ['3-setup-v5.sql', 'update-turn.sql']) ok(norm(fromSql(f)) === norm(builtin), '网页内置的中转列表和 ' + f + ' 完全一致');
ok(builtin[0].name === 'ExpressTURN', '主力是 ExpressTURN');
const udpOthers = builtin.slice(1).filter(p => p.urls.some(u => /^turn:/.test(u) && !/transport=tcp/.test(u)));
ok(udpOthers.length === 0, '除了 ExpressTURN，其他中转都没有 UDP 地址' + (udpOthers.length ? '：' + udpOthers.map(p => p.name).join('、') : ''));
const stun = new Function('return ' + src.match(/const STUN_SERVER = (\{[^\n]*\});/)[1])().urls;
ok(stun.length === 5 && !stun.some(u => /qq\.com/.test(u)), 'STUN 是实测能用的 5 个，没有 stun.qq.com：' + stun.join('、'));
process.exit(fails ? 1 : 0);
