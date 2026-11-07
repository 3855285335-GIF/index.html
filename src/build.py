# 构建：把 shell.html（页面骨架和样式）+ loader.html（依赖库加载器）+ app.js（全部逻辑）+ 图标
# 合成一个单文件网页，输出到 ../site/index.html。用法：python3 src/build.py
import base64, os, sys, urllib.parse
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import logo
def rd(name, mode='r'):
    p = os.path.join(HERE, name)
    return open(p, 'rb').read() if mode == 'rb' else open(p, encoding='utf-8').read()
shell = rd('shell.html'); app = rd('app.js'); loader = rd('loader.html')
fav = rd('favicon.svg')
fav_uri = 'data:image/svg+xml,' + urllib.parse.quote(fav, safe="/:=' ")
apple = 'data:image/png;base64,' + base64.b64encode(rd('icon-180.png', 'rb')).decode()
shell = shell.replace('__FAVICON__', fav_uri).replace('__APPLE_ICON__', apple).replace('__LOADER__', loader).replace('__LOGO_SYMBOL__', logo.symbol())
shell = shell.replace('</style>', '  .list-card:empty { display: none; }\n</style>', 1)
out = shell.replace('/*__APP__*/', app)
for k in ('__FAVICON__', '__APPLE_ICON__', '__LOADER__', '__LOGO_SYMBOL__', '__APP__', '__ICON'):
    assert k not in out, k
dst = os.path.join(HERE, '..', 'site', 'index.html')
open(dst, 'w', encoding='utf-8').write(out)
# 后台小助手（只管通知，不缓存页面）：版本号用页面上显示的 build
import re
build = re.search(r'<div class="build">build ([^<]+)</div>', shell).group(1)
sw = rd('sw.js').replace('__BUILD__', build)
open(os.path.join(HERE, '..', 'site', 'sw.js'), 'w', encoding='utf-8').write(sw)
# 添加到主屏幕用的 manifest（单独的文件：iPhone 16.4–18 要靠它的 display: standalone 才算“网页 App”，才能收推送）
import json
man = {'name': 'Chatter', 'short_name': 'Chatter', 'description': '絮语 · 即时聊天、语音与视频通话', 'lang': 'zh-CN',
       'start_url': './', 'scope': './', 'display': 'standalone', 'orientation': 'portrait', 'background_color': '#12101c', 'theme_color': '#6c5ce7',
       'icons': [{'src': 'icon-192.png', 'sizes': '192x192', 'type': 'image/png', 'purpose': 'any'},
                 {'src': 'icon-512.png', 'sizes': '512x512', 'type': 'image/png', 'purpose': 'any'},
                 {'src': 'icon-maskable-512.png', 'sizes': '512x512', 'type': 'image/png', 'purpose': 'maskable'}]}
open(os.path.join(HERE, '..', 'site', 'manifest.webmanifest'), 'w', encoding='utf-8').write(json.dumps(man, ensure_ascii=False, indent=1))
print('已生成', os.path.normpath(dst), len(out), '字节')
