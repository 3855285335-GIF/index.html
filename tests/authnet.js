// 登录 / 注册的提示要说对原因：连不上服务器时不能说成“密码错误”或“请先执行 setup.sql”
const { chromium } = require('playwright');
const fs = require('fs');
const html = fs.readFileSync(__dirname + '/../site/index.html', 'utf8');
let lib = fs.readFileSync(__dirname + '/fakelib.js', 'utf8'); while (lib.length < 21000) lib += '/* createClient */';
const results = []; const ok = (c, t) => results.push((c ? 'PASS ' : 'FAIL ') + t);
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 780 } });
  await ctx.route('https://app.test/**', r => /\.(js|png|webmanifest)$/.test(r.request().url()) ? r.fulfill({ status: 404, body: '' }) : r.fulfill({ status: 200, contentType: 'text/html', body: html }));
  await ctx.route(/supabase-js|supabase\.min\.js/, r => r.fulfill({ status: 200, contentType: 'application/javascript', body: lib }));
  const seed = { profiles: [{ id: 'uid-alice', account_id: 'alice', nickname: 'Alice' }], friendships: [], messages: [], conversations: [], friend_requests: [], stickers: [] };
  const errors = [];
  const P = await ctx.newPage();
  P.on('pageerror', e => errors.push(e.message));
  await P.addInitScript(() => { window.__netFail = true; });
  await P.goto('https://app.test/');
  await P.evaluate(s => localStorage.setItem('fakedb', JSON.stringify(s)), seed);
  await P.reload(); await sleep(300);
  const msg = () => P.textContent('#auth-msg');
  const reg = async (acc, pass, name) => { await P.click('#tab-register'); await P.fill('#reg-acc', acc); await P.fill('#reg-pass', pass); await P.fill('#reg-name', name); await P.click('#register-form button[type=submit]'); await sleep(500); };
  const login = async (acc, pass) => { await P.click('#tab-login'); await P.fill('#login-acc', acc); await P.fill('#login-pass', pass); await P.click('#login-form button[type=submit]'); await sleep(500); };

  // 连不上服务器
  await reg('czm1', 'abc123', '与你');
  let m = await msg();
  ok(/连不上服务器/.test(m) && !/setup\.sql/.test(m), '注册时连不上服务器：提示“连不上服务器”，不再说“请先执行 setup.sql”：' + m.slice(0, 24));
  await login('alice', 'whatever');
  m = await msg();
  ok(/连不上服务器/.test(m) && !/密码错误/.test(m), '登录时连不上服务器：提示“连不上服务器”，不会误说“账号或密码错误”');

  // 网络恢复
  await P.evaluate(() => { window.__netFail = false; window.__realPw = 'right1'; });
  await login('alice', 'wrong1');
  ok(/账号或密码错误/.test(await msg()), '网络正常、密码错：仍然提示“账号或密码错误”');
  await reg('alice', 'abc123', '重名');
  ok(/账号已存在/.test(await msg()), '注册已存在的账号：提示“账号已存在”');
  await P.evaluate(() => { window.__noAccFn = true; });
  await reg('newone', 'abc123', '新人');
  m = await msg();
  ok(/1-setup\.sql/.test(m), '后端真的没建好时：才提示运行 1-setup.sql');
  await P.evaluate(() => { window.__noAccFn = false; window.__realPw = null; });
  await reg('czm1', 'czm111', '与你');
  await P.waitForSelector('#app-view.active', { timeout: 5000 }).catch(() => {});
  ok(await P.isVisible('#app-view.active') && await P.evaluate(() => window.__signedUp) === 'czm1', '网络正常时注册 czm1 成功，进入 App');

  ok(errors.length === 0, '页面无未捕获错误' + (errors.length ? '：' + errors.slice(0, 4).join(' | ') : ''));
  console.log(results.join('\n')); await browser.close(); process.exit(results.some(r => r.startsWith('FAIL')) ? 1 : 0);
})().catch(e => { console.log(results.join('\n')); console.log('TEST CRASH', e.message); process.exit(2); });
