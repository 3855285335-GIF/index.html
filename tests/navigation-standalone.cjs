// 单人页面用真实 Chromium 和受控地点来源；可独立运行，无账号和后台。
const assert = require('node:assert/strict'),
  http = require('node:http'),
  path = require('node:path'),
  fs = require('node:fs');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
(async () => {
  const server = http.createServer((req, res) => {
    const p = new URL(req.url, 'http://localhost').pathname.slice(1);
    if (
      !/^(navigation\.(html|js|css)|navigation-sound\.js|vendor\/(earth-relief-50m\.webp|navigation-cue\.wav)|vendor\/natural-earth-110m\.js|vendor\/leaflet\/(leaflet\.(js|css)|images\/[a-z0-9-]+\.png))$/.test(p)
    ) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.setHeader(
      'content-type',
      {
        '.html': 'text/html; charset=utf-8',
        '.js': 'text/javascript',
        '.css': 'text/css',
        '.wav': 'audio/wav', '.webp': 'image/webp', '.png': 'image/png'
      }[path.extname(p)]
    );
    fs.createReadStream(path.join(root, p)).pipe(res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port + '/navigation.html';
  const br = await chromium.launch();
  try {
    const page = await br.newPage({ viewport: { width: 390, height: 844 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    let releaseFirst, firstSeen;
    const started = new Promise((r) => {
      firstSeen = r;
    });
    const result = (name, city, lon, lat) => ({
      geometry: { type: 'Point', coordinates: [lon, lat] },
      properties: { name, city }
    });
    await page.route('https://photon.komoot.io/**', async (route) => {
      const q = new URL(route.request().url()).searchParams.get('q');
      if (q === '故障') return route.fulfill({ status: 503, body: '' });
      if (q === '旧查询') {
        firstSeen();
        await new Promise((r) => {
          releaseFirst = r;
        });
      }
      const features =
        q === '空结果' ? [] : [result('南站', '甲城', 121.47, 31.23), result('南站', '乙城', 114.31, 30.52)];
      await route.fulfill({ json: { features } }).catch(() => {});
    });
    await page.route('https://tile.openstreetmap.org/**', (r) => r.abort());
    let streetRequests = 0, geolocationRequests = 0;
    page.on('request', (request) => {
      if (request.url().startsWith('https://tile.openstreetmap.org/')) ++streetRequests;
    });
    await page.exposeFunction('locationRequested', () => { ++geolocationRequests; });
    await page.addInitScript(() => Object.defineProperty(navigator, 'geolocation', { value: {
      getCurrentPosition(_ok, fail) { window.locationRequested(); fail({ code: 1 }); }
    }}));
    await page.addInitScript(() => {
      window.spoken = [];
      window.voices = [{ localService: true, name: '测试普通话', lang: 'zh-CN' }];
      Object.defineProperty(window, 'speechSynthesis', { value: {
        getVoices: () => window.voices,
        speak: (u) => window.spoken.push(u.text),
        cancel: () => {}
      } });
      Object.defineProperty(window, 'SpeechSynthesisUtterance', { value: class { constructor(text) { this.text = text; } } });
    });
    await page.goto(base);
    await page.waitForSelector('#map.relief');
    await page.click('#map-expand');
    assert.ok(await page.locator('#map-dialog').isVisible());
    await page.keyboard.press('Escape');
    await page.waitForSelector('main #map-expand');
    assert.equal(await page.locator('#map-expand').innerText(), '全屏地图');
    assert.deepEqual(await page.evaluate(() => window.spoken), []);
    await page.click('#open-sound');
    assert.ok(await page.locator('#sound-options [value=off]').isChecked());
    await page.click('#try-voice');
    assert.equal((await page.evaluate(() => window.spoken)).length, 1);
    assert.ok(await page.locator('#sound-options [value=off]').isChecked());
    const cue = page.waitForResponse(r => r.url().endsWith('navigation-cue.wav'));
    await page.click('#try-sound');
    const wave = await cue;
    assert.ok(wave.ok());
    assert.equal((await wave.body()).subarray(0,4).toString(), 'RIFF');
    await page.evaluate(() => { window.voices[0].localService = false; });
    await page.click('#try-voice');
    await page.locator('#sound-status').filter({hasText:'本机普通话'}).waitFor();
    assert.equal((await page.evaluate(() => window.spoken)).length, 1);
    await page.evaluate(() => { window.voices[0].localService = true; });
    await page.locator('#sound-options [value=voice]').check();
    await page.click('#close-sound');
    await page.locator('#map .overview-land').waitFor({ state: 'attached' });
    assert.equal(streetRequests, 0);
    assert.equal(geolocationRequests, 0);
    assert.equal(await page.locator('#map .nav-pin').count(), 0);
    assert.equal(await page.locator('#confirmed').isVisible(), false);
    await page.click('#pick');
    await page.locator('#map').click({ position: { x: 100, y: 80 } });
    await page.locator('#map-status').filter({ hasText: '先放大' }).waitFor();
    assert.equal(await page.locator('#manual').getAttribute('open'), null);
    await page.click('#pick');
    await page.click('#nearby');
    await page.locator('#nearby-status').filter({ hasText: '未取得定位' }).waitFor();
    assert.equal(geolocationRequests, 1);
    for (const theme of ['dark', 'light']) {
      await page.emulateMedia({ colorScheme: theme });
      await page.waitForFunction((dark) => document.documentElement.hasAttribute('data-dark') === dark, theme === 'dark');
      for (const width of [320, 390, 1024]) {
        await page.setViewportSize({ width, height: 844 });
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), theme + width);
        const form = await page.locator('#search').boundingBox(), map = await page.locator('#map').boundingBox();
        if (width > 820) assert.ok(map.x >= form.x + form.width);
        else assert.ok(map.y + map.height <= form.y);
      }
    }
    await page.setViewportSize({ width: 390, height: 844 });
    console.log('地图总览无需定位或街道网络；拒绝定位后仍可搜索；320、390、1024 像素宽度与深浅主题均通过。');
    const search = async (q) => {
      if (await page.locator('#replace').isVisible()) await page.click('#replace');
      await page.fill('#query', q);
      await page.press('#query', 'Enter');
    };
    await search('旧查询');
    await started;
    await search('南站');
    await page.locator('#results button').nth(1).waitFor();
    releaseFirst();
    assert.equal(await page.locator('#route').isVisible(), false);
    await page.locator('#results button').filter({ hasText: '乙城' }).click();
    const u = new URL(await page.locator('#route').getAttribute('href'));
    assert.equal(u.hostname, 'uri.amap.com');
    assert.equal(u.pathname, '/marker');
    assert.equal(u.searchParams.get('coordinate'), 'wgs84');
    assert.equal(u.searchParams.get('position'), '114.31,30.52');
    await page.locator('#map-status').filter({ hasText: '未加载' }).waitFor();
    assert.ok((await page.locator('#dest-info').innerText()).includes('乙城'));
    let snappedFar = false,
      routeQueries = [];
    await page.route('https://routing.openstreetmap.de/**', async (r) => {
      const request = new URL(r.request().url());
      assert.equal(request.searchParams.get('steps'), 'true');
      routeQueries.push(request.pathname);
      const line = [[114.3, 30.51], snappedFar ? [114.35, 30.56] : [114.31, 30.52]];
      await r.fulfill({
        json: {
          code: 'Ok',
          routes: [{ geometry: { type: 'LineString', coordinates: line }, distance: 1700, duration: 1200,
            legs: [{ steps: [
              { name: '东街', distance: 900, maneuver: { type: 'depart' } },
              { name: '车站路', distance: 800, maneuver: { type: 'turn', modifier: 'left' } },
              { name: '', distance: 0, maneuver: { type: 'arrive' } }
            ] }] }]
        }
      });
    });
    assert.ok(await page.locator('#plan-go').isVisible());
    assert.equal(await page.locator('#dest-name').evaluate((el) => el === document.activeElement), true);
    await page.click('#pick');
    await page.locator('#map').click({ position: { x: 80, y: 80 } });
    await page.locator('#map-status').filter({ hasText: '街道底图未加载' }).waitFor();
    assert.equal(await page.locator('#confirmed').isVisible(), true);
    await page.click('#pick');
    await page.selectOption('#start-source', 'manual');
    await page.fill('#from-lat', '30.51');
    await page.fill('#from-lon', '114.30');
    await page.click('#plan-go');
    await page.locator('#route-summary').waitFor();
    assert.equal(await page.locator('#duration').innerText(), '20');
    assert.equal(await page.locator('#distance').innerText(), '1.7');
    assert.match((await page.evaluate(() => window.spoken)).at(-1), /步行前往南站.*20 分钟.*1.7 公里/);
    await page.locator('#steps summary').click();
    assert.match(await page.locator('#step-list li').nth(1).innerText(), /左转.*车站路/);
    await page.getByRole('button', {name:'朗读第 2 段'}).click();
    assert.match((await page.evaluate(() => window.spoken)).at(-1), /路线预览，第 2 段.*左转.*车站路/);
    await page.locator('#plan summary').click();
    assert.equal(routeQueries[0], '/routed-foot/route/v1/driving/114.3,30.51;114.31,30.52');
    snappedFar = true;
    await page.getByRole('radio', { name: '骑行' }).check();
    assert.equal(await page.locator('#plan-go').innerText(), '计算骑行路线');
    await page.waitForTimeout(1250);
    await page.click('#plan-go');
    await page.locator('#plan-status').filter({ hasText: '相距较远' }).waitFor();
    assert.ok(routeQueries[1].startsWith('/routed-bike/'));
    assert.equal(await page.locator('#route-summary').isVisible(), false);
    assert.equal(
      new URL(await page.locator('#route').getAttribute('href')).searchParams.get('position'),
      '114.31,30.52'
    );
    console.log('步行路线按选定入口计算；骑行服务返回远处道路时拒绝绘制并保留原终点。');
    await page.click('#replace');
    assert.ok(await page.locator('#recent-places button').filter({hasText:'乙城'}).isVisible());
    await page.locator('#recent-places button').click();
    assert.equal(await page.locator('#dest-name').innerText(), '南站');
    await page.click('#replace');
    await page.click('#clear-recents');
    assert.equal(await page.locator('#recents').isVisible(), false);
    await search('故障');
    await page.locator('#search-status').filter({ hasText: '未完成' }).waitFor();
    assert.equal(await page.locator('#route').isVisible(), false);
    await search('空结果');
    await page.locator('#search-status').filter({ hasText: '没有匹配' }).waitFor();
    await page.goto(base + '#lat=121.3&lon=31.2&name=错误');
    assert.equal(await page.locator('#route').isVisible(), false);
    await page.goto(base + '#lat=0&lon=0&name=原点');
    assert.equal(
      new URL(await page.locator('#route').getAttribute('href')).searchParams.get('position'),
      '0,0'
    );
    await page.route('https://tile.openstreetmap.org/**', (r) => r.fulfill({
      contentType: 'image/png', body: fs.readFileSync(path.join(root, 'vendor/leaflet/images/marker-icon.png'))
    }));
    await page.reload();
    await page.click('#open-sound');
    assert.ok(await page.locator('#sound-options [value=off]').isChecked());
    await page.click('#close-sound');
    await page.locator('#map .leaflet-tile-loaded').first().waitFor();
    await page.click('#pick');
    await page.locator('#map').click({ position: { x: 115, y: 91 } });
    await page.locator('#place-name').waitFor();
    assert.ok(await page.locator('#place-name').evaluate((el) => document.activeElement === el));
    assert.ok(Math.abs(Number(await page.locator('#lat').inputValue())) < 0.01);
    await page.fill('#place-name', '手选北门');
    await page.click('#coords button');
    assert.equal(await page.locator('#dest-name').innerText(), '手选北门');
    assert.deepEqual(errors, []);
    console.log(
      '双城市同名地点需要手选，旧回包、来源故障和无结果均不跳到旧路线；无底图保留已选坐标；超界拒绝、合法零值通过。'
    );
  } finally {
    await br.close();
    await new Promise((r) => server.close(r));
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
