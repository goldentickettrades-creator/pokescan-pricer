"""Build data/sealed_pics.json + data/sealed_pics.bin: a picture fingerprint for every sealed product.

Lets the app recognise a booster box, ETB, tin or pack from a photo on the phone itself, with no AI
service. Reads the product list from data/sealed.json (built by build_sealed.py) and only downloads
pictures for products that are not fingerprinted yet. Run weekly by .github/workflows/pictures.yml.

Fingerprint (must stay identical to sealedPrint() in vision.js), 144 bytes per product:
  1. Product photo -> trim the white background -> turn landscape shapes upright.
  2. bytes 0-63 hash, 64-127 mask: the same 16x16 difference hash as cards, on the shape stretched square.
  3. bytes 128-139: hue histogram (12 bins, saturated pixels only, lightly smoothed, sums to ~255).
  4. byte 143: shape, short side / long side * 255.

Usage: python tools/build_sealed_pics.py [--cache DIR]   (DIR holds <productId>.jpg thumbnails to reuse)
"""
import colorsys
import io
import json
import os
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor

from PIL import Image, ImageChops

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data")
SRC = os.path.join(ROOT, "sealed.json")
JSON_OUT, BIN_OUT = os.path.join(ROOT, "sealed_pics.json"), os.path.join(ROOT, "sealed_pics.bin")
GRID, REC = 16, 144
UA = {"User-Agent": "pokescan-pricer index build (github.com/goldentickettrades-creator/pokescan-pricer)"}


def fetch(url, tries=3):
    for attempt in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=40) as r:
                return r.read()
        except Exception:
            if attempt == tries - 1:
                raise
            time.sleep(1 + attempt)


def fingerprint(img):
    img = img.convert("RGB")
    # Trim the white studio background.
    diff = ImageChops.difference(img, Image.new("RGB", img.size, (255, 255, 255))).convert("L").point(lambda v: 255 if v > 14 else 0)
    box = diff.getbbox()
    if box and (box[2] - box[0]) >= 16 and (box[3] - box[1]) >= 16:
        img = img.crop(box)
    if img.width > img.height:
        img = img.transpose(Image.ROTATE_90)
    aspect = min(img.size) / max(img.size)

    g = list(img.convert("L").resize((GRID, GRID), Image.BOX).getdata())
    diffs = [g[r * GRID + c] - g[r * GRID + c + 1] for r in range(GRID) for c in range(GRID - 1)]
    diffs += [g[r * GRID + c] - g[(r + 1) * GRID + c] for r in range(GRID - 1) for c in range(GRID)]
    h, m = bytearray(64), bytearray(64)
    for i, d in enumerate(diffs):
        if d > 0:
            h[i >> 3] |= 1 << (i & 7)
        if abs(d) >= 4:
            m[i >> 3] |= 1 << (i & 7)

    bins = [0.0] * 12
    px = list(img.resize((48, 48), Image.BOX).getdata())
    for r, gg, b in px:
        hh, s, v = colorsys.rgb_to_hsv(r / 255, gg / 255, b / 255)
        if s >= 0.25 and v >= 0.2:
            bins[int(hh * 12) % 12] += 1
    total = sum(bins)
    tail = bytearray(16)
    if total >= 0.05 * len(px):
        bins = [x / total for x in bins]
        smooth = [0.5 * bins[i] + 0.25 * bins[i - 1] + 0.25 * bins[(i + 1) % 12] for i in range(12)]
        for i, x in enumerate(smooth):
            tail[i] = min(255, round(x * 255))
    tail[15] = min(255, round(aspect * 255))
    return bytes(h) + bytes(m) + bytes(tail)


def load_existing():
    try:
        pids = json.load(open(JSON_OUT, encoding="utf-8"))["pids"]
        blob = open(BIN_OUT, "rb").read()
    except Exception:
        return {}
    if len(pids) * REC != len(blob):
        return {}
    return {pid: blob[i * REC:(i + 1) * REC] for i, pid in enumerate(pids)}


def main():
    cache = sys.argv[sys.argv.index("--cache") + 1] if "--cache" in sys.argv else None
    pids = [p[0] for p in json.load(open(SRC, encoding="utf-8"))["products"]]
    have = load_existing()

    def work(pid):
        if pid in have:
            return have[pid]
        try:
            p = cache and os.path.join(cache, f"{pid}.jpg")
            data = open(p, "rb").read() if p and os.path.exists(p) else fetch(f"https://tcgplayer-cdn.tcgplayer.com/product/{pid}_200w.jpg")
            return fingerprint(Image.open(io.BytesIO(data)))
        except Exception as e:
            print("skip", pid, e)
            return None

    with ThreadPoolExecutor(12) as ex:
        prints = list(ex.map(work, pids))
    kept = [(pid, fp) for pid, fp in zip(pids, prints) if fp is not None]
    new = sum(1 for pid, _ in kept if pid not in have)
    if new == 0 and len(kept) == len(have):
        print(f"no changes ({len(kept)} products)")
        return
    with open(JSON_OUT, "w", encoding="utf-8") as f:
        json.dump({"updated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "pids": [pid for pid, _ in kept]}, f, separators=(",", ":"))
    with open(BIN_OUT, "wb") as f:
        f.write(b"".join(fp for _, fp in kept))
    print(f"{len(kept)} sealed products fingerprinted ({new} new)")


if __name__ == "__main__":
    main()
