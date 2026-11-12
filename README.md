# PokéScan Pricer

Scan Pokémon cards and sealed product with your phone and get the current market value. No account, no API key.

**Open it:** https://goldentickettrades-creator.github.io/pokescan-pricer/
On a phone, add it to your home screen (Share → Add to Home Screen on iPhone, ⋮ → Add to Home screen on Android).

## What it does

- **Live cards** – point the camera at one card, a row, or a whole binder page. Each card's market price appears on it within about a second and follows it as you move. No photos to take. Tap a price tag for the full prices and printings, or tap **Add** to put everything in view into your binder.
- **Sealed** – fill the view with the front of a booster box, ETB, tin, bundle or pack and tap Scan box.
- **Upload** – pick a photo instead of using the camera.
- **Search** – type a card ("Charizard 4/102") or a sealed product ("151 ETB").
- **Binder** – a running list of what you've added, with totals, Undo, and CSV export. Saved in your browser on that device.

## Raw vs graded

The app tells a bare card from one in a graded slab, and never prices a slab as if it were raw.

- It recognizes a slab by its outline (a case is narrower for its height than a card), by a PSA-style label above the card, or by reading the label. When the slab is large in view it reads the company and grade ("PSA 10", "CGC 9.5").
- On a card's result you can always switch between **Raw** and a company and grade yourself.
- Graded prices (recent eBay sales for that exact grade) come from [Pokemon Price Tracker](https://www.pokemonpricetracker.com). Paste a free key in **Settings → Graded prices**; the free plan covers about 50 graded lookups a day. Without a key the app shows the grade and a one-tap eBay sold-listings link for it instead of a price.
- Graded copies are saved in the binder with their grade, separate from raw copies.

## How it recognizes things

Everything runs on your phone, free, with no account or API key:

- Every English card (about 19,700) and sealed product (about 2,800) has a small picture fingerprint in `data/`. The app fingerprints what the camera sees and finds the closest match, so cards are recognized by their artwork, not by reading text.
- When two printings share the same artwork (reprints), the price tag shows a "?". With one card filling the view the app reads the collector number to pick the right one; otherwise tap the tag and choose your printing.
- With several cards in view it finds each card's outline first, then matches them one by one. On a binder page it also uses the cards it found to work out where the neighbouring pockets are, so dark or shiny cards that blend into the pocket are still picked up.

Optionally, **Settings → Card reader** can add Claude or ChatGPT as a backup for scans the built-in reader isn't sure about (about a cent per use on your own API key, stored only in your browser). You don't need it.

Tips: good even light, tilt holos and sleeves away from glare, and get close enough that the cards fill most of the view. English cards only. Sealed works best straight-on; it always shows a short list to confirm when it isn't certain.

## Where the data comes from

- **Card prices:** the free [TCGdex API](https://tcgdex.dev), refreshed daily. Near-mint, ungraded.
- **Sealed prices:** `data/sealed.json`, rebuilt every day by a GitHub Action (`.github/workflows/sealed.yml`) from [TCGCSV](https://tcgcsv.com), a mirror of TCGplayer's catalog and prices.
- **Picture fingerprints:** `data/cards.*` and `data/sealed_pics.*`, refreshed every Monday (`.github/workflows/pictures.yml`) so new sets get picked up.

Graded slabs (PSA, CGC) sell for different amounts; use the eBay sold link on each result for those.

## Run it on your computer

```
python -m http.server 8917
```

Then open http://localhost:8917. On Windows you can double-click `start.bat` instead.
