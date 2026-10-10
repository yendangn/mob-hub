# Draws the app icon: a 2x2 grid of phones on a dark macOS-style rounded square.
# Output: build/icon.png (1024x1024) and build/icon.icns. electron-builder uses build/ by default.
# Run: python3 scripts/make-icon.py   (needs Pillow; icon.icns needs macOS iconutil)
import shutil
import subprocess
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

SIZE = 1024
SS = 4  # supersampling factor for smooth edges
S = SIZE * SS
OUT = Path(__file__).resolve().parent.parent / "build"


def hex_rgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i : i + 2], 16) for i in (0, 2, 4))


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def vgradient(w, h, top, bottom):
    g = Image.new("RGB", (1, h))
    for y in range(h):
        g.putpixel((0, y), lerp(top, bottom, y / max(h - 1, 1)))
    return g.resize((w, h))


def rounded_mask(w, h, r):
    m = Image.new("L", (w, h), 0)
    ImageDraw.Draw(m).rounded_rectangle((0, 0, w - 1, h - 1), r, fill=255)
    return m


def draw():
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))

    # macOS icon grid: 824px body centered in 1024 canvas, corner radius ~185px.
    body = 824 * SS
    off = (S - body) // 2
    radius = 185 * SS

    # drop shadow under the body
    shadow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle(
        (off, off + 14 * SS, off + body, off + body + 14 * SS), radius, fill=(0, 0, 0, 110)
    )
    img.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(18 * SS)))

    bg = vgradient(body, body, hex_rgb("#232838"), hex_rgb("#0f1115")).convert("RGBA")
    img.paste(bg, (off, off), rounded_mask(body, body, radius))

    # thin inner highlight on the body edge
    edge = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(edge).rounded_rectangle(
        (off, off, off + body - 1, off + body - 1), radius, outline=(255, 255, 255, 28), width=3 * SS
    )
    img.alpha_composite(edge)

    # 2x2 phones
    pw, ph = 190 * SS, 310 * SS
    gap = 56 * SS
    gx = (S - (2 * pw + gap)) // 2
    gy = (S - (2 * ph + gap)) // 2
    accent = hex_rgb("#5b8cff")
    accent2 = hex_rgb("#2f5fd6")
    screens = [
        (lerp(accent, (255, 255, 255), 0.25), accent),  # highlighted phone
        (accent, accent2),
        (accent, accent2),
        (accent, accent2),
    ]
    for i, (top, bottom) in enumerate(screens):
        x = gx + (i % 2) * (pw + gap)
        y = gy + (i // 2) * (ph + gap)
        # phone frame
        frame = Image.new("RGBA", (S, S), (0, 0, 0, 0))
        fd = ImageDraw.Draw(frame)
        fd.rounded_rectangle((x, y, x + pw, y + ph), 38 * SS, fill=hex_rgb("#e6e8ee") + (255,))
        img.alpha_composite(frame)
        # screen
        b = 14 * SS
        sw, sh = pw - 2 * b, ph - 2 * b
        scr = vgradient(sw, sh, top, bottom).convert("RGBA")
        img.paste(scr, (x + b, y + b), rounded_mask(sw, sh, 26 * SS))
        # camera dot
        cd = ImageDraw.Draw(img)
        cr = 7 * SS
        cx, cy = x + pw // 2, y + b + 20 * SS
        cd.ellipse((cx - cr, cy - cr, cx + cr, cy + cr), fill=hex_rgb("#0f1115") + (200,))

    # sync glyph on the highlighted phone: a small play triangle = live mirror
    d = ImageDraw.Draw(img)
    x, y = gx, gy
    cx, cy = x + pw // 2, y + ph // 2 + 8 * SS
    t = 46 * SS
    d.polygon([(cx - t * 0.8, cy - t), (cx - t * 0.8, cy + t), (cx + t, cy)], fill=(255, 255, 255, 235))

    return img.resize((SIZE, SIZE), Image.LANCZOS)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    icon = draw()
    png = OUT / "icon.png"
    icon.save(png)
    print(f"saved {png}")

    if not shutil.which("iconutil"):
        print("iconutil not found: skip icon.icns")
        return
    with tempfile.TemporaryDirectory() as tmp:
        iconset = Path(tmp) / "icon.iconset"
        iconset.mkdir()
        for s in (16, 32, 128, 256, 512):
            icon.resize((s, s), Image.LANCZOS).save(iconset / f"icon_{s}x{s}.png")
            icon.resize((s * 2, s * 2), Image.LANCZOS).save(iconset / f"icon_{s}x{s}@2x.png")
        icns = OUT / "icon.icns"
        subprocess.run(["iconutil", "-c", "icns", str(iconset), "-o", str(icns)], check=True)
        print(f"saved {icns}")


if __name__ == "__main__":
    main()
