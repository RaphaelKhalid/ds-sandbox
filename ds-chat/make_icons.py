"""Draw ds-chat's icons (a "DS" monogram) so it doesn't reuse K2's artwork.  python make_icons.py"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).parent
BG = (35, 55, 140)          # deep blue
FG = (245, 240, 230)        # the app's cream (#f5f0e6)
FONT = Path(r"C:\Windows\Fonts\segoeuib.ttf")


def draw(size, rounded=False, text_frac=0.42):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if rounded:
        d.rounded_rectangle([0, 0, size - 1, size - 1], radius=int(size * 0.22), fill=BG)
    else:
        d.rectangle([0, 0, size, size], fill=BG)
    font = ImageFont.truetype(str(FONT), int(size * text_frac)) if FONT.exists() else ImageFont.load_default()
    box = d.textbbox((0, 0), "DS", font=font)
    w, h = box[2] - box[0], box[3] - box[1]
    d.text(((size - w) / 2 - box[0], (size - h) / 2 - box[1]), "DS", font=font, fill=FG)
    return img


draw(192).save(HERE / "icon-192.png")
draw(512).save(HERE / "icon-512.png")                         # also the maskable icon: text sits in the safe zone
draw(180).convert("RGB").save(HERE / "apple-touch-icon.png")  # iOS wants no transparency; it rounds corners itself
draw(256, rounded=True).save(HERE / "icon.ico", sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
print("wrote icon-192.png, icon-512.png, apple-touch-icon.png, icon.ico")
