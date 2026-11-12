"""Build data/cards.json + data/cards.bin: a picture fingerprint for every English card on TCGdex.

The app compares what the camera sees against these fingerprints, so cards are recognised by their
artwork on the phone itself, with no AI service. Run weekly by .github/workflows/cards.yml; it only
downloads cards that are not in the index yet.

Fingerprint (must stay identical to cardHash() in app.js):
  1. Card image -> luminance -> 16x16 grid of area averages.
  2. 240 horizontal neighbour differences (row-major) then 240 vertical ones.
  3. hash bit = difference > 0; mask bit = |difference| >= 4 (flat areas carry no information).
  4. Bits packed LSB-first into 60 bytes, padded to 64. Each card stores hash (64 bytes) then mask (64 bytes).

Usage: python tools/build_cards.py [--cache DIR]   (DIR holds <card id>.webp thumbnails to reuse)
"""
import io
import json
import os
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor

from PIL import Image

API = "https://api.tcgdex.net/v2/en"
ASSETS = "https://assets.tcgdex.net/en/"
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data")
JSON_OUT, BIN_OUT = os.path.join(ROOT, "cards.json"), os.path.join(ROOT, "cards.bin")
GRID, REC = 16, 128
UA = {"User-Agent": "pokescan-pricer index build (github.com/goldentickettrades-creator/pokescan-pricer)"}


def fetch(url, tries=4):
    for attempt in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=40) as r:
                return r.read()
        except Exception:
            if attempt == tries - 1:
                raise
            time.sleep(1 + attempt)


def fingerprint(img):
    g = list(img.convert("L").resize((GRID, GRID), Image.BOX).getdata())
    diffs = [g[r * GRID + c] - g[r * GRID + c + 1] for r in range(GRID) for c in range(GRID - 1)]
    diffs += [g[r * GRID + c] - g[(r + 1) * GRID + c] for r in range(GRID - 1) for c in range(GRID)]
    h, m = bytearray(64), bytearray(64)
    for i, d in enumerate(diffs):
        if d > 0:
            h[i >> 3] |= 1 << (i & 7)
        if abs(d) >= 4:
            m[i >> 3] |= 1 << (i & 7)
    return bytes(h) + bytes(m)


def load_existing():
    try:
        meta = json.load(open(JSON_OUT, encoding="utf-8"))
        blob = open(BIN_OUT, "rb").read()
    except Exception:
        return {}
    out, i = {}, 0
    for sid, _name, _official, _total, _path, cards in meta["sets"]:
        for local_id, _card_name in cards:
            out[f"{sid}-{local_id}"] = blob[i * REC:(i + 1) * REC]
            i += 1
    return out if i * REC == len(blob) else {}


def main():
    cache = sys.argv[sys.argv.index("--cache") + 1] if "--cache" in sys.argv else None
    cards = [c for c in json.loads(fetch(f"{API}/cards")) if c.get("image") and "/tcgp/" not in c["image"]]
    sets = {s["id"]: s for s in json.loads(fetch(f"{API}/sets"))}
    have = load_existing()

    def work(c):
        if c["id"] in have:
            return have[c["id"]]
        try:
            p = cache and os.path.join(cache, c["id"] + ".webp")
            data = open(p, "rb").read() if p and os.path.exists(p) else fetch(c["image"] + "/low.webp")
            return fingerprint(Image.open(io.BytesIO(data)))
        except Exception as e:
            print("skip", c["id"], e)
            return None

    with ThreadPoolExecutor(16) as ex:
        prints = list(ex.map(work, cards))

    by_set, order = {}, []
    for c, fp in zip(cards, prints):
        if fp is None:
            continue
        sid = c["id"][: -(len(c["localId"]) + 1)]
        path = c["image"][len(ASSETS): -(len(c["localId"]) + 1)]
        if sid not in by_set:
            s = sets.get(sid, {})
            cc = s.get("cardCount", {})
            by_set[sid] = [sid, s.get("name", sid), cc.get("official"), cc.get("total"), path, []]
            order.append(sid)
        by_set[sid][5].append(([c["localId"], c["name"]], fp))

    blob = bytearray()
    out_sets = []
    for sid in order:
        s = by_set[sid]
        out_sets.append(s[:5] + [[meta for meta, _ in s[5]]])
        for _, fp in s[5]:
            blob += fp
    total = len(blob) // REC
    new = sum(1 for c, fp in zip(cards, prints) if fp is not None and c["id"] not in have)
    if new == 0 and total == len(have):
        print(f"no changes ({total} cards)")
        return
    os.makedirs(ROOT, exist_ok=True)
    with open(JSON_OUT, "w", encoding="utf-8") as f:
        json.dump({"updated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "count": total, "sets": out_sets}, f, ensure_ascii=False, separators=(",", ":"))
    with open(BIN_OUT, "wb") as f:
        f.write(blob)
    print(f"{total} cards in {len(out_sets)} sets ({new} new)")


if __name__ == "__main__":
    main()
