# 生成 Lumark 应用图标：build/icon.png + build/icon.ico
# 蓝色圆角底 + 白色 L（对应首页空状态的品牌色 #4094f7）
from PIL import Image, ImageDraw, ImageFont
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_PNG = os.path.join(ROOT, 'build', 'icon.png')
OUT_ICO = os.path.join(ROOT, 'build', 'icon.ico')
os.makedirs(os.path.dirname(OUT_PNG), exist_ok=True)

SIZE = 512                     # 超采样后缩到 256，抗锯齿
BG = (64, 148, 247, 255)       # --accent light #4094f7
FG = (255, 255, 255, 255)

img = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
d = ImageDraw.Draw(img)
r = int(SIZE * 0.22)                                   # 圆角半径
d.rounded_rectangle([0, 0, SIZE - 1, SIZE - 1], radius=r, fill=BG)

font = None
for fp in [r'C:\Windows\Fonts\segoeuil.ttf',           # Segoe UI Light（贴近首页 L 的细字重）
           r'C:\Windows\Fonts\segoeui.ttf',
           r'C:\Windows\Fonts\arialbd.ttf']:
    try:
        font = ImageFont.truetype(fp, int(SIZE * 0.52))
        break
    except Exception:
        continue
if font is None:
    font = ImageFont.load_default()

bbox = d.textbbox((0, 0), 'L', font=font)
w = bbox[2] - bbox[0]
h = bbox[3] - bbox[1]
x = (SIZE - w) / 2 - bbox[0] + SIZE * 0.02             # L 字偏左，右移 2% 视觉居中
y = (SIZE - h) / 2 - bbox[1] - SIZE * 0.03
d.text((x, y), 'L', font=font, fill=FG)

icon = img.resize((256, 256), Image.LANCZOS)
icon.save(OUT_PNG)
icon.save(OUT_ICO, sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
print('wrote', OUT_PNG, OUT_ICO)
