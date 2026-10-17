# สร้างไอคอนแอป (เพิ่มไปยังหน้าจอโฮม) 3 แบบจากตราโรงเรียน public/img/school-logo.png
# A ตราเต็มกรอบ · B ตราบนวงกลมครีม · C แดงไล่เฉด ขอบทอง · พื้นแดงเลือดหมู #6C1422
# ได้ icon-<แบบ>-180.png (ไอโฟน) 192 และ 512 (แอนดรอยด์ คอม) และ maskable-<แบบ>-512.png (ตราย่อเหลือในวงปลอดภัย 80% ของแอนดรอยด์)
# รันใหม่เมื่อเปลี่ยนตรา: python scripts/make-app-icons.py
import os
from PIL import Image, ImageDraw, ImageFilter
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOGO = Image.open(os.path.join(ROOT, 'public', 'img', 'school-logo.png')).convert('RGBA')
OUT = os.path.join(ROOT, 'public', 'img', 'app')
RED = (108, 20, 34)

def icon(style, S=1024, scale=1.0):
    bg = Image.new('RGBA', (S, S), RED + (255,))
    d = ImageDraw.Draw(bg)
    if style == 'C':
        top = (150, 34, 52)
        for y in range(S):
            t = y / S
            d.line((0, y, S, y), fill=tuple(int(top[i] * (1 - t) + RED[i] * t) for i in range(3)) + (255,))
        inset = int(S * 0.03 + S * (1 - scale) / 2)
        d.rounded_rectangle((inset, inset, S - 1 - inset, S - 1 - inset), int(S * 0.19 * scale), outline=(227, 162, 26, 255), width=max(2, int(S * 0.016)))
    if style == 'B':
        cr = int(S * 0.40 * scale)
        d.ellipse((S // 2 - cr, S // 2 - cr, S // 2 + cr, S // 2 + cr), fill=(255, 248, 236, 255))
        h = int(S * 0.66 * scale)
    else:
        h = int(S * 0.80 * scale)
    w = int(LOGO.width * h / LOGO.height)
    lg = LOGO.resize((w, h), Image.LANCZOS)
    if style != 'B':
        sh = Image.new('RGBA', lg.size, (0, 0, 0, 0))
        sh.putalpha(lg.split()[3].point(lambda a: int(a * 0.45)))
        sh = sh.filter(ImageFilter.GaussianBlur(S // 85))
        bg.alpha_composite(sh, ((S - w) // 2, (S - h) // 2 + S // 85))
    bg.alpha_composite(lg, ((S - w) // 2, (S - h) // 2))
    return bg.convert('RGB')

os.makedirs(OUT, exist_ok=True)
for s in 'ABC':
    big = icon(s)
    for n in (180, 192, 512):
        big.resize((n, n), Image.LANCZOS).save(os.path.join(OUT, f'icon-{s}-{n}.png'), optimize=True)
    icon(s, scale=0.78).resize((512, 512), Image.LANCZOS).save(os.path.join(OUT, f'maskable-{s}-512.png'), optimize=True)
print('ok')
