# PokéScan Pricer

Scan a Pokémon card with your phone or webcam and get its current market value (TCGplayer USD and Cardmarket EUR, via the free [TCGdex API](https://tcgdex.dev)).

- Runs entirely in the browser; card text is read on-device with Tesseract.js.
- Optional: add an Anthropic API key in Settings for sharper recognition (stored only in your browser).
- Keep a binder of your cards with a running total.

Run locally: `python -m http.server 8917`, then open http://localhost:8917.
