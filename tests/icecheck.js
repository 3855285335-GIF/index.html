// 检查：内置的 STUN/TURN 地址，以及 ExpressTURN 的地址格式，浏览器都能接受
const { chromium } = require('playwright'); const fs = require('fs');
(async () => {
  const b = await chromium.launch(); const p = await b.newPage();
  const src = fs.readFileSync(require('path').join(__dirname, '..', 'src', 'app.js'), 'utf8');
  const m = src.match(/const STUN_SERVER[\s\S]*?\n\];\n/);
  const r = await p.evaluate(code => {
    try {
      const f = new Function(code + ';return [STUN_SERVER].concat(TURN_DEFAULT.map(x => ({ urls: x.urls, username: x.username, credential: x.credential })));');
      const ice = f().concat([{ urls: ['turn:free.expressturn.com:3478?transport=udp', 'turn:free.expressturn.com:3478?transport=tcp'], username: 'u', credential: 'p' }]);
      const pc = new RTCPeerConnection({ iceServers: ice, bundlePolicy: 'max-bundle' }); pc.close();
      return { ok: true, servers: ice.length };
    } catch (e) { return { ok: false, err: String(e) }; }
  }, m[0]);
  console.log(JSON.stringify(r)); await b.close(); process.exit(r.ok ? 0 : 1);
})();
