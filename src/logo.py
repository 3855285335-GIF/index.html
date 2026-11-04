# Chatter 图标（极简版）：纯色紫底 + 一个白色对话气泡，气泡里三个由小到大的"打字点"，最后一个点是粉色。
DEFS = ''
def art(scale=1.0):
    t = f'translate(256 256) scale({scale}) translate(-256 -256)'
    return f'''<g transform="{t}">
<g fill="#fff"><rect x="96" y="120" width="320" height="236" rx="96"/><path d="M158 340 L132 416 L236 350 Z"/></g>
<circle cx="180" cy="238" r="20" fill="#6C4DF0" fill-opacity=".45"/><circle cx="256" cy="238" r="27" fill="#6C4DF0" fill-opacity=".75"/><circle cx="342" cy="238" r="35" fill="#FF4F8B"/>
</g>'''
def tile(rounded=True, scale=1.0):
    rx = 115 if rounded else 0
    return f'<rect width="512" height="512" rx="{rx}" fill="#5B3BD8"/>' + art(scale)
def svg(size, rounded=True, scale=1.0):
    return f'<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" viewBox="0 0 512 512">{tile(rounded, scale)}</svg>'
def symbol():
    return f'<svg width="0" height="0" style="position:absolute" aria-hidden="true"><symbol id="logo" viewBox="0 0 512 512">{tile(True, 1.0)}</symbol></svg>'
