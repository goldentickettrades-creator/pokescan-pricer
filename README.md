# PokéScan Pricer

Scan Pokémon cards and sealed product with your phone and get the current market value. No account, no API key.

**Open it:** https://goldentickettrades-creator.github.io/pokescan-pricer/
On a phone, add it to your home screen (Share → Add to Home Screen on iPhone, ⋮ → Add to Home screen on Android).

## What it does

- **Card** – hold one card in the frame and tap Scan. Shows TCGplayer market (USD) and Cardmarket trend (EUR), per printing.
- **Multi** – lay several cards on a plain surface with a little space between them and tap Scan all. Review the list, then add everything in one tap.
- **Sealed** – fill the view with the front of a booster box, ETB, tin, bundle or pack and tap Scan box.
- **Search** – type a card ("Charizard 4/102") or a sealed product ("151 ETB").
- **Binder** – a running list of what you've added, with totals, Undo, and CSV export. Saved in your browser on that device.

## How it recognizes things

Everything runs on your phone, free, with no account or API key:

- Every English card (about 19,700) and sealed product (about 2,800) has a small picture fingerprint in `data/`. The app fingerprints what the camera sees and finds the closest match, so cards are recognized by their artwork, not by reading text.
- When two printings share the same artwork (reprints), the app reads the collector number to pick the right one. If it can't, it shows both and you tap yours.
- In Multi mode it finds each card's outline in the photo first, then matches them one by one.

Optionally, **Settings → Card reader** can add Claude or ChatGPT as a backup for scans the built-in reader isn't sure about (about a cent per use on your own API key, stored only in your browser). You don't need it.

Tips: good even light, tilt holos away from glare, and for Multi use a plain surface with gaps between cards. Sealed works best straight-on; it always shows a short list to confirm when it isn't certain.

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
