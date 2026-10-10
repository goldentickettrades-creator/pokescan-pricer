"""Build data/sealed.json: every Pokémon sealed product on TCGplayer with its current prices.

Source: tcgcsv.com (a daily mirror of TCGplayer's catalog and prices). Run daily by
.github/workflows/sealed.yml so the app can read sealed prices from its own site.
"""
import json
import os
import time
import urllib.request

BASE = "https://tcgcsv.com/tcgplayer/3"  # category 3 = Pokémon
OUT = os.path.join(os.path.dirname(__file__), "..", "data", "sealed.json")


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "pokescan-pricer (github.com/goldentickettrades-creator/pokescan-pricer)"})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.load(r)["results"]
        except Exception:
            if attempt == 2:
                raise
            time.sleep(2)


def is_sealed(p):
    # Singles carry a collector Number; sealed products and accessories do not.
    if any(e.get("name") == "Number" for e in p.get("extendedData", [])):
        return False
    return not p["name"].lower().startswith("code card")


def main():
    groups = get(f"{BASE}/groups")
    out_groups, rows = {}, []
    for g in groups:
        gid = g["groupId"]
        try:
            products = get(f"{BASE}/{gid}/products")
            prices = get(f"{BASE}/{gid}/prices")
        except Exception as e:  # one bad set should not sink the whole build
            print("skip", gid, e)
            continue
        by_id = {}
        for pr in prices:
            # Prefer the "Normal" sub-type when a product lists several.
            if pr["productId"] not in by_id or pr.get("subTypeName") == "Normal":
                by_id[pr["productId"]] = pr
        kept = 0
        for p in products:
            if not is_sealed(p):
                continue
            pr = by_id.get(p["productId"], {})
            rows.append([p["productId"], p["name"], gid, pr.get("marketPrice"), pr.get("lowPrice"), pr.get("midPrice"), pr.get("highPrice")])
            kept += 1
        if kept:
            out_groups[gid] = [g["name"], (g.get("publishedOn") or "")[:10]]
        time.sleep(0.05)
    data = {
        "updated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "fields": ["productId", "name", "groupId", "market", "low", "mid", "high"],
        "groups": out_groups,
        "products": rows,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
    print(f"{len(rows)} sealed products across {len(out_groups)} sets")


if __name__ == "__main__":
    main()
