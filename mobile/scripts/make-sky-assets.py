# 하늘 배경 그림 만들기 — assets/sky/*.png (탭 화면 위쪽 SkyBackdrop이 씀)
# 그림을 손으로 그리지 않고 여기서 계산해 만듦. 모양 · 색을 바꾸려면 이 파일을 고쳐 다시 돌림:
#   python scripts/make-sky-assets.py        (Pillow 필요: pip install pillow)
import math
import random
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter

OUT = Path(__file__).resolve().parent.parent / "assets" / "sky"
OUT.mkdir(parents=True, exist_ok=True)


def falloff(size, power, inner=0.0):
    """가운데가 진하고 가장자리로 갈수록 투명해지는 둥근 알파. inner까지는 꽉 참"""
    g = ImageChops.invert(Image.radial_gradient("L")).resize((size, size), Image.LANCZOS)

    def curve(v):
        t = v / 255
        t = min(1.0, t / (1 - inner)) if inner < 1 else 1.0
        return int(255 * t**power)

    return g.point(curve)


def solid(size, color, alpha):
    img = Image.new("RGBA", size if isinstance(size, tuple) else (size, size), color + (0,))
    img.putalpha(alpha)
    return img


def cloud(seed, color, shade, w=720, h=300):
    """봉우리 여러 개가 뭉친 구름 — 가장자리는 흐리게, 아래쪽은 살짝 어둡게 해서 부피감"""
    rnd = random.Random(seed)
    mask = Image.new("L", (w, h), 0)
    d = ImageDraw.Draw(mask)
    base = h * 0.74
    d.rounded_rectangle([w * 0.1, base - h * 0.2, w * 0.9, base + h * 0.04], radius=h * 0.12, fill=255)
    n = rnd.choice([6, 7, 8])
    for i in range(n):
        mid = 1 - abs(i - (n - 1) / 2) / ((n - 1) / 2)  # 가운데일수록 1
        r = h * (0.15 + 0.2 * mid) * rnd.uniform(0.85, 1.15)
        cx = w * (0.2 + 0.6 * i / (n - 1)) + rnd.uniform(-14, 14)
        cy = base - h * 0.14 - r * rnd.uniform(0.35, 0.75)
        d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=255)
    soft = mask.filter(ImageFilter.GaussianBlur(h * 0.05))
    # 가장자리는 더 넓게 번지게 한 겹 더
    wide = mask.filter(ImageFilter.GaussianBlur(h * 0.11)).point(lambda v: int(v * 0.55))
    alpha = ImageChops.lighter(soft, wide)
    grad = Image.linear_gradient("L").resize((w, h))  # 위 0 → 아래 255
    lower = grad.point(lambda v: int(max(0, v - 120) * 1.5))
    rgb = Image.composite(Image.new("RGB", (w, h), shade), Image.new("RGB", (w, h), color), lower)
    out = rgb.convert("RGBA")
    out.putalpha(alpha)
    return out


def sun(core, glow, size=640):
    """해 — 또렷한 원 + 넓게 번지는 빛"""
    img = solid(size, glow, falloff(size, 2.2).point(lambda v: int(v * 0.8)))
    disc = solid(size, core, falloff(size, 0.5, inner=0.0).point(lambda v: 255 if v > 0 else 0))
    r = int(size * 0.105)
    m = Image.new("L", (size, size), 0)
    ImageDraw.Draw(m).ellipse([size / 2 - r, size / 2 - r, size / 2 + r, size / 2 + r], fill=255)
    disc.putalpha(m.filter(ImageFilter.GaussianBlur(size * 0.012)))
    return Image.alpha_composite(img, disc)


def rays(color, size=720, count=12):
    """해 둘레 빛줄기 — 천천히 돌려 씀"""
    m = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(m)
    c = size / 2
    rnd = random.Random(7)
    for i in range(count):
        a = 2 * math.pi * i / count + rnd.uniform(-0.08, 0.08)
        half = rnd.uniform(0.035, 0.075)
        length = c * rnd.uniform(0.7, 1.0)
        d.polygon([(c, c), (c + length * math.cos(a - half), c + length * math.sin(a - half)), (c + length * math.cos(a + half), c + length * math.sin(a + half))], fill=255)
    m = m.filter(ImageFilter.GaussianBlur(size * 0.012))
    m = ImageChops.multiply(m, falloff(size, 1.4)).point(lambda v: int(v * 0.5))
    return solid(size, color, m)


def moon(color, size=240):
    """초승달 — 밝은 쪽은 또렷하게, 그늘 쪽은 희미하게 비침"""
    c = size / 2
    r = size * 0.36
    full = Image.new("L", (size, size), 0)
    ImageDraw.Draw(full).ellipse([c - r, c - r, c + r, c + r], fill=255)
    cut = Image.new("L", (size, size), 0)
    ImageDraw.Draw(cut).ellipse([c - r + r * 0.55, c - r - r * 0.28, c + r + r * 0.55, c + r - r * 0.28], fill=255)
    cut = cut.filter(ImageFilter.GaussianBlur(size * 0.012))
    lit = ImageChops.subtract(full, cut)
    alpha = ImageChops.lighter(lit, full.point(lambda v: int(v * 0.16))).filter(ImageFilter.GaussianBlur(size * 0.006))
    return solid(size, color, alpha)


def streak(color, w=16, h=140):
    """빗줄기 · 별똥별 — 위는 투명하고 아래로 갈수록 진한 가는 선"""
    m = Image.new("L", (w, h), 0)
    ImageDraw.Draw(m).rounded_rectangle([w / 2 - 2, 4, w / 2 + 2, h - 4], radius=2, fill=255)
    grad = Image.linear_gradient("L").resize((w, h)).point(lambda v: int(255 * (v / 255) ** 1.6))
    m = ImageChops.multiply(m.filter(ImageFilter.GaussianBlur(1.1)), grad)
    return solid((w, h), color, m)


def sparkle(color, size=96):
    """별 — 네 방향으로 뻗은 반짝임"""
    c = size / 2
    m = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(m)
    long, thin = size * 0.46, size * 0.045
    d.polygon([(c, c - long), (c + thin, c), (c, c + long), (c - thin, c)], fill=255)
    d.polygon([(c - long, c), (c, c - thin), (c + long, c), (c, c + thin)], fill=255)
    m = m.filter(ImageFilter.GaussianBlur(size * 0.012))
    m = ImageChops.lighter(m, falloff(size, 3.2).point(lambda v: int(v * 0.9)))
    return solid(size, color, m)


def ball(size, blur):
    """먼 눈 — 위는 희고 아래는 옅은 푸른 그늘이 진 작은 눈 뭉치. 둘레 테 없음"""
    c = size / 2
    r = size * 0.34
    m = Image.new("L", (size, size), 0)
    ImageDraw.Draw(m).ellipse([c - r, c - r, c + r, c + r], fill=255)
    m = m.filter(ImageFilter.GaussianBlur(size * blur))
    grad = Image.linear_gradient("L").resize((size, size)).point(lambda v: int(min(255, max(0, v - 70) * 1.5)))
    rgb = Image.composite(Image.new("RGB", (size, size), (158, 184, 226)), Image.new("RGB", (size, size), (255, 255, 255)), grad)
    out = rgb.convert("RGBA")
    out.putalpha(m)
    return out


def crystal(size=200):
    """눈 결정 — 여섯 갈래에 잔가지. 흰 결정 아래에 옅은 푸른 그늘을 깔아 밝은 하늘에서도 보이게"""
    big = size * 3
    c = big / 2
    m = Image.new("L", (big, big), 0)
    d = ImageDraw.Draw(m)
    R = big * 0.4
    wd = int(big * 0.03)

    def line(x0, y0, a, length, width):
        x1, y1 = x0 + length * math.cos(a), y0 + length * math.sin(a)
        d.line([(x0, y0), (x1, y1)], fill=255, width=width)
        d.ellipse([x1 - width / 2, y1 - width / 2, x1 + width / 2, y1 + width / 2], fill=255)

    for k in range(6):
        a = math.pi / 3 * k - math.pi / 2
        line(c, c, a, R, wd)
        for at, ln in ((0.42, 0.3), (0.68, 0.2)):
            bx, by = c + R * at * math.cos(a), c + R * at * math.sin(a)
            line(bx, by, a + math.pi / 3, R * ln, int(wd * 0.8))
            line(bx, by, a - math.pi / 3, R * ln, int(wd * 0.8))
    d.ellipse([c - wd * 1.3, c - wd * 1.3, c + wd * 1.3, c + wd * 1.3], fill=255)
    m = m.resize((size, size), Image.LANCZOS)
    shade = solid(size, (96, 130, 190), m.filter(ImageFilter.GaussianBlur(size * 0.022)).point(lambda v: int(min(255, v * 1.5) * 0.6)))
    return Image.alpha_composite(shade, solid(size, (255, 255, 255), m))


WHITE = (255, 255, 255)
files = {
    "cloud-1.png": cloud(11, WHITE, (222, 231, 242)),
    "cloud-2.png": cloud(23, WHITE, (222, 231, 242)),
    "cloud-3.png": cloud(42, WHITE, (222, 231, 242)),
    "cloud-gray-1.png": cloud(11, (232, 237, 243), (176, 190, 207)),
    "cloud-gray-2.png": cloud(23, (232, 237, 243), (176, 190, 207)),
    "cloud-gray-3.png": cloud(42, (232, 237, 243), (176, 190, 207)),
    "sun-day.png": sun((255, 226, 130), (255, 205, 96)),
    "sun-low.png": sun((255, 186, 130), (255, 138, 96)),
    "rays.png": rays((255, 232, 170)),
    "moon.png": moon((255, 251, 232)),
    "glow-moon.png": solid(360, (255, 250, 225), falloff(360, 2.4).point(lambda v: int(v * 0.6))),
    "flare.png": solid(160, (255, 244, 214), falloff(160, 1.3).point(lambda v: int(v * 0.55))),
    "ball.png": ball(72, 0.03),
    "crystal.png": crystal(),
    "rain.png": streak((58, 92, 134)),
    "shooting.png": streak(WHITE),
    "star.png": sparkle(WHITE),
}
for name, img in files.items():
    img.save(OUT / name, optimize=True)
    print(name, img.size, (OUT / name).stat().st_size // 1024, "KB")
