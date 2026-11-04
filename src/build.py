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
shell = shell.replace('<link rel="manifest" href="manifest.webmanifest">\n', '')
shell = shell.replace('__FAVICON__', fav_uri).replace('__APPLE_ICON__', apple).replace('__LOADER__', loader).replace('__LOGO_SYMBOL__', logo.symbol())
shell = shell.replace('</style>', '  .list-card:empty { display: none; }\n</style>', 1)
out = shell.replace('/*__APP__*/', app)
for k in ('__FAVICON__', '__APPLE_ICON__', '__LOADER__', '__LOGO_SYMBOL__', '__APP__', '__ICON'):
    assert k not in out, k
dst = os.path.join(HERE, '..', 'site', 'index.html')
open(dst, 'w', encoding='utf-8').write(out)
print('已生成', os.path.normpath(dst), len(out), '字节')
