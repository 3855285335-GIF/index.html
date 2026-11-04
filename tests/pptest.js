// 依赖库加载器测试：模拟 webpack 打包的库（启动时需要推断 publicPath），确认能内联执行、被缓存、不报 publicPath 错误
const { chromium } = require('playwright'); const fs = require('fs'); const path = require('path');
const mock = `(function(){var scriptUrl;var document=window.document;if(document.currentScript&&document.currentScript.tagName.toUpperCase()==='SCRIPT')scriptUrl=document.currentScript.src;if(!scriptUrl){var scripts=document.getElementsByTagName('script');if(scripts.length){var i=scripts.length-1;while(i>-1&&!scriptUrl)scriptUrl=scripts[i--].src;}}if(!scriptUrl)throw new Error("Automatic publicPath is not supported in this browser");window.supabase={createClient:function(){return {mock:true}}};/*createClient*/})();` + ' '.repeat(21000);
(async () => {
  const b = await chromium.launch(); const ctx = await b.newContext();
  const html = fs.readFileSync(path.join(__dirname, '..', 'site', 'index.html'), 'utf8'); const errs = [];
  await ctx.route('https://app.test/**', r => r.fulfill({ status: 200, contentType: 'text/html', body: html }));
  await ctx.route(/jsdelivr|unpkg|npmmirror|bootcdn|cdnjs/, r => r.fulfill({ status: 200, contentType: 'application/javascript', body: mock }));
  await ctx.route(/esm\.sh|esm\.run/, r => r.abort());
  const p = await ctx.newPage(); p.on('pageerror', e => errs.push(e.message));
  await p.goto('https://app.test/'); await p.waitForTimeout(3000);
  const r = await p.evaluate(() => ({ lib: !!(window.supabase && window.supabase.createClient), cached: Object.keys(localStorage).filter(k => k.startsWith('ch2lib')).length }));
  const n = errs.filter(e => /publicPath/.test(e)).length, ok = r.lib && r.cached === 1 && n === 0;
  console.log((ok ? 'PASS' : 'FAIL') + ' 依赖库加载：库可用=' + r.lib + ' 已缓存=' + r.cached + ' publicPath 报错=' + n);
  await b.close(); process.exit(ok ? 0 : 1);
})();
