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
      !/^(navigation\.(html|js|css)|vendor\/leaflet\/(leaflet\.(js|css)|images\/[a-z0-9-]+\.png))$/.test(p)
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
        '.png': 'image/png'
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
    await page.goto(base);
    const search = async (q) => {
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
      routeQueries.push(request.pathname);
      const line = [[114.3, 30.51], snappedFar ? [114.35, 30.56] : [114.31, 30.52]];
      await r.fulfill({
        json: {
          code: 'Ok',
          routes: [{ geometry: { type: 'LineString', coordinates: line }, distance: 1700, duration: 1200 }]
        }
      });
    });
    await page.locator('#plan summary').click();
    await page.selectOption('#start-source', 'manual');
    await page.fill('#from-lat', '30.51');
    await page.fill('#from-lon', '114.30');
    await page.click('#plan-go');
    await page.locator('#plan-status').filter({ hasText: '1.70 公里' }).waitFor();
    assert.equal(routeQueries[0], '/routed-foot/route/v1/driving/114.3,30.51;114.31,30.52');
    snappedFar = true;
    await page.selectOption('#mode', 'bike');
    await page.waitForTimeout(1250);
    await page.click('#plan-go');
    await page.locator('#plan-status').filter({ hasText: '相距较远' }).waitFor();
    assert.ok(routeQueries[1].startsWith('/routed-bike/'));
    assert.equal(
      new URL(await page.locator('#route').getAttribute('href')).searchParams.get('position'),
      '114.31,30.52'
    );
    console.log('步行路线按选定入口计算；骑行服务返回远处道路时拒绝绘制并保留原终点。');
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
