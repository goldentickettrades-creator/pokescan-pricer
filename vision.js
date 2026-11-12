'use strict';
/*
 * On-device recognition: no AI service involved.
 *  - A picture fingerprint for every card (data/cards.bin, built by tools/build_cards.py) lets the app
 *    recognise a card by its artwork.
 *  - detectCards() finds card-shaped objects in a photo so several cards can be scanned at once.
 *  - Sealed products are recognised the same way from data/sealed_pics.bin.
 *  - Text reading (Tesseract) is only used to tell apart reprints that share the same artwork.
 * Loaded after app.js and uses its helpers (normText, nameScore, parseNumber, ocrCard, ...).
 */

/* ---------- picture index ---------- */

const REC_WORDS = 32;          // per card: 16 words of hash, then 16 words of mask
let indexPromise = null;

function getIndex() {
  if (!indexPromise) {
    indexPromise = (async () => {
      const [meta, buf] = await Promise.all([
        getJSON('data/cards.json'),
        fetch('data/cards.bin').then((r) => { if (!r.ok) throw new Error('Could not load the card pictures index.'); return r.arrayBuffer(); }),
      ]);
      const cards = [];
      const sets = new Map();
      for (const [sid, name, official, total, path, list] of meta.sets) {
        const set = { id: sid, name, cardCount: { official, total } };
        sets.set(sid, set);
        for (const [localId, cardName] of list) {
          cards.push({ id: `${sid}-${localId}`, localId, name: cardName, image: `https://assets.tcgdex.net/en/${path}/${localId}`, set, nn: normText(cardName), ln: normLocal(localId) });
        }
      }
      const words = new Uint32Array(buf);
      if (words.length !== cards.length * REC_WORDS) throw new Error('The card pictures index is out of sync. Reload the page.');
      const maskBits = new Uint16Array(cards.length);
      for (let k = 0; k < cards.length; k++) {
        let n = 0;
        for (let j = 16; j < 32; j++) n += pop32(words[k * REC_WORDS + j]);
        maskBits[k] = Math.max(n, 1);
      }
      return { cards, sets, words, maskBits, n: cards.length, byId: new Map(cards.map((c, i) => [c.id, i])) };
    })().catch((e) => { indexPromise = null; throw e; });
  }
  return indexPromise;
}

function pop32(v) {
  v -= (v >>> 1) & 0x55555555;
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return Math.imul((v + (v >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24;
}

/* ---------- fingerprint (must match tools/build_cards.py) ---------- */

const hashCanvas = document.createElement('canvas');
hashCanvas.width = hashCanvas.height = 128;
const hashCtx = hashCanvas.getContext('2d', { willReadFrequently: true });

/** 16x16 grid of average brightness of whatever is drawn on the 128x128 hash canvas. */
function gridFromCanvas() {
  const d = hashCtx.getImageData(0, 0, 128, 128).data;
  const g = new Float32Array(256);
  for (let r = 0; r < 16; r++) {
    for (let c = 0; c < 16; c++) {
      let s = 0;
      for (let y = 0; y < 8; y++) {
        let i = ((r * 8 + y) * 128 + c * 8) * 4;
        for (let x = 0; x < 8; x++, i += 4) s += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      }
      g[r * 16 + c] = s / 64;
    }
  }
  return g;
}

function bitsFromGrid(g) {
  const bytes = new Uint8Array(64);
  let i = 0;
  for (let r = 0; r < 16; r++) for (let c = 0; c < 15; c++, i++) if (g[r * 16 + c] > g[r * 16 + c + 1]) bytes[i >> 3] |= 1 << (i & 7);
  for (let r = 0; r < 15; r++) for (let c = 0; c < 16; c++, i++) if (g[r * 16 + c] > g[(r + 1) * 16 + c]) bytes[i >> 3] |= 1 << (i & 7);
  return new Uint32Array(bytes.buffer);
}

/** The same grid seen after a quarter turn. */
function rotateGrid(g) {
  const o = new Float32Array(256);
  for (let r = 0; r < 16; r++) for (let c = 0; c < 16; c++) o[c * 16 + (15 - r)] = g[r * 16 + c];
  return o;
}

const hashFromCanvas = () => bitsFromGrid(gridFromCanvas());

/** Fingerprint of the region (sx, sy, sw, sh) of `src`; `flip` reads it upside-down. */
function cardHash(src, sx, sy, sw, sh, flip = false) {
  hashCtx.imageSmoothingEnabled = true;
  hashCtx.imageSmoothingQuality = 'high';
  if (flip) hashCtx.setTransform(-1, 0, 0, -1, 128, 128); else hashCtx.setTransform(1, 0, 0, 1, 0, 0);
  hashCtx.drawImage(src, sx, sy, sw, sh, 0, 0, 128, 128);
  return hashFromCanvas();
}

const JITTER_INSETS = [-0.03, 0, 0.03];
const JITTER_SHIFTS = [-0.025, 0, 0.025];

/** Fingerprints of a card view at slightly different crops, to forgive imperfect framing. */
function jitterHashes(view, flip, full = true, wide = false) {
  const out = [];
  const insets = full ? JITTER_INSETS : [0], shifts = !full ? [0] : wide ? JITTER_SHIFTS.map((x) => x * 2) : JITTER_SHIFTS;
  for (const s of insets) for (const dx of shifts) for (const dy of shifts) {
    out.push(cardHash(view.canvas, view.x + view.w * (s + dx), view.y + view.h * (s + dy), view.w * (1 - 2 * s), view.h * (1 - 2 * s), flip));
  }
  return out;
}

/** Distance (0 = identical, ~0.5 = unrelated) from the best of `qs` to every card in the index. */
function imageRank(index, qs) {
  const { words, maskBits, n } = index;
  const dist = new Float32Array(n);
  const nq = qs.length;
  for (let k = 0; k < n; k++) {
    const o = k * REC_WORDS;
    let best = 1e9;
    for (let q = 0; q < nq; q++) {
      const h = qs[q];
      let x = 0;
      for (let j = 0; j < 15; j++) x += pop32((h[j] ^ words[o + j]) & words[o + 16 + j]);
      if (x < best) best = x;
    }
    dist[k] = best / maskBits[k];
  }
  return dist;
}

/** Distance from the best of `qs` to one card. */
function distTo(index, i, qs) {
  const { words, maskBits } = index, o = i * REC_WORDS;
  let best = 1e9;
  for (const h of qs) {
    let x = 0;
    for (let j = 0; j < 15; j++) x += pop32((h[j] ^ words[o + j]) & words[o + 16 + j]);
    if (x < best) best = x;
  }
  return best / maskBits[i];
}

function topMatches(dist, k) {
  const top = [];
  for (let i = 0; i < dist.length; i++) {
    const d = dist[i];
    if (top.length < k || d < top[top.length - 1].d) {
      let j = top.length;
      while (j > 0 && top[j - 1].d > d) j--;
      top.splice(j, 0, { i, d });
      if (top.length > k) top.pop();
    }
  }
  return top;
}

// Tuned on 19,659 cards with simulated camera distortion: within these limits there were no wrong picks.
const IMG_SURE = 0.20;      // best distance must be at most this...
const IMG_GAP = 0.04;       // ...and beat the closest different-looking card by this much
const IMG_TIE = 0.09;       // reprints of the same artwork (often with a different frame) land within this of each other
const imgScore = (d) => 8 * Math.max(0, Math.min(1, (0.30 - d) / 0.14));

function imageVerdict(index, dist) {
  const top = topMatches(dist, 40);
  const best = top[0];
  const name = index.cards[best.i].nn;
  const other = top.find((t) => index.cards[t.i].nn !== name);
  const decided = best.d <= IMG_SURE && (!other || other.d - best.d >= IMG_GAP);
  const ties = top.filter((t) => index.cards[t.i].nn === name && t.d <= best.d + IMG_TIE);
  return { top, best, decided, ties };
}

/* ---------- finding cards in a photo ---------- */

const CARD_ASPECT = 63 / 88;

function convexHull(pts) {
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const p of pts) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop(); lower.push(p); }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop(); upper.push(p); }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

/** Smallest rotated rectangle around a convex hull. Returns centre, short side w, long side h, and the angle of the short side. */
function minAreaRect(hull) {
  let best = null;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i], b = hull[(i + 1) % hull.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 1e-6) continue;
    const ux = (b[0] - a[0]) / len, uy = (b[1] - a[1]) / len;
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (const p of hull) {
      const u = p[0] * ux + p[1] * uy, v = -p[0] * uy + p[1] * ux;
      if (u < minU) minU = u; if (u > maxU) maxU = u; if (v < minV) minV = v; if (v > maxV) maxV = v;
    }
    const area = (maxU - minU) * (maxV - minV);
    if (!best || area < best.area) best = { area, ux, uy, cu: (minU + maxU) / 2, cv: (minV + maxV) / 2, w: maxU - minU, h: maxV - minV };
  }
  if (!best) return null;
  let { ux, uy, w, h } = best;
  const cx = best.cu * ux - best.cv * uy, cy = best.cu * uy + best.cv * ux;
  let angle = Math.atan2(uy, ux);
  if (w > h) { [w, h] = [h, w]; angle += Math.PI / 2; }
  // The short side's direction is only known up to a half turn; keep the answer nearest to upright.
  while (angle > Math.PI / 2) angle -= Math.PI;
  while (angle <= -Math.PI / 2) angle += Math.PI;
  return { cx, cy, w, h, angle };
}

/**
 * Find solid shapes in a photo. Two ways of telling "thing" from "not thing":
 *   mode 'ring'   - differs in colour from the surface seen around the edge of the photo (loose cards on a table)
 *   mode 'bright' - brighter than the dark material between cards (binder pages, dark playmats)
 * Returns rectangles in `src` pixels: { cx, cy, w (short side), h (long side), angle, fit, frac, box }.
 */
function detectBlobs(src, { minFrac = 0.012, mode = 'ring', maxSide = 1024 } = {}) {
  const k = Math.min(1, maxSide / Math.max(src.width, src.height));
  const w = Math.max(16, Math.round(src.width * k)), h = Math.max(16, Math.round(src.height * k));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;

  // One number per pixel saying how "thing-like" it is, then an automatic (Otsu) cut-off.
  const val = new Uint8Array(w * h);
  if (mode === 'bright') {
    for (let p = 0, i = 0; p < w * h; p++, i += 4) val[p] = Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
  } else {
    // Background colour: the median of each edge strip, blended across the photo so uneven lighting is tolerated.
    const ring = Math.max(2, Math.round(Math.min(w, h) * 0.03));
    const strips = { top: [[], [], []], bottom: [[], [], []], left: [[], [], []], right: [[], [], []] };
    const put = (s, i) => { s[0].push(d[i]); s[1].push(d[i + 1]); s[2].push(d[i + 2]); };
    for (let y = 0; y < h; y += 2) for (let x = 0; x < w; x += 2) {
      const i = (y * w + x) * 4;
      if (y < ring) put(strips.top, i); else if (y >= h - ring) put(strips.bottom, i);
      if (x < ring) put(strips.left, i); else if (x >= w - ring) put(strips.right, i);
    }
    const med = (a) => { a.sort((p, q) => p - q); return a[a.length >> 1]; };
    const T = strips.top.map(med), B = strips.bottom.map(med), L = strips.left.map(med), R = strips.right.map(med);
    for (let y = 0, p = 0; y < h; y++) {
      const fy = y / (h - 1);
      for (let x = 0; x < w; x++, p++) {
        const fx = x / (w - 1), i = p * 4;
        const br = (T[0] * (1 - fy) + B[0] * fy + L[0] * (1 - fx) + R[0] * fx) / 2;
        const bg = (T[1] * (1 - fy) + B[1] * fy + L[1] * (1 - fx) + R[1] * fx) / 2;
        const bb = (T[2] * (1 - fy) + B[2] * fy + L[2] * (1 - fx) + R[2] * fx) / 2;
        val[p] = Math.min(255, Math.round(Math.hypot(d[i] - br, d[i + 1] - bg, d[i + 2] - bb) / 1.732));
      }
    }
  }
  const hist = new Uint32Array(256);
  for (let p = 0; p < w * h; p++) hist[val[p]]++;
  let sum = 0; for (let t = 0; t < 256; t++) sum += t * hist[t];
  let wB = 0, sumB = 0, maxVar = -1, thr = 32;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]; if (!wB) continue;
    const wF = w * h - wB; if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF, v = wB * wF * (mB - mF) * (mB - mF);
    if (v > maxVar) { maxVar = v; thr = t; }
  }
  // In 'ring' mode Otsu splits "clearly card" from the rest; a card's border only needs to differ a little, so go lower.
  if (mode !== 'bright') thr = Math.max(12, Math.round(thr * 0.55));

  let mask = new Uint8Array(w * h);
  for (let p = 0; p < w * h; p++) mask[p] = val[p] > thr ? 1 : 0;
  const morph = (m, dilate) => {
    const o = new Uint8Array(w * h);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const p = y * w + x;
      o[p] = dilate ? m[p] | m[p - 1] | m[p + 1] | m[p - w] | m[p + w] : m[p] & m[p - 1] & m[p + 1] & m[p - w] & m[p + w];
    }
    return o;
  };
  // Close 1px gaps in card outlines (not in 'bright' mode, where the thin dark gaps between cards are the signal).
  if (mode !== 'bright') mask = morph(morph(mask, true), false);
  else {
    // A light table around a dark binder is "bright" too. Drop any big bright area that runs off the edge of the
    // photo, otherwise it would count as an outline enclosing the whole binder.
    const seen = new Uint8Array(w * h), q = new Int32Array(w * h);
    const flood = (start) => {
      let qh = 0, qt = 0;
      q[qt++] = start; seen[start] = 1;
      while (qh < qt) {
        const p = q[qh++], x = p % w;
        for (const n of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p - w, p + w]) {
          if (n >= 0 && n < w * h && mask[n] && !seen[n]) { seen[n] = 1; q[qt++] = n; }
        }
      }
      if (qt > 0.08 * w * h) for (let i = 0; i < qt; i++) mask[q[i]] = 0;
    };
    for (let x = 0; x < w; x++) for (const p of [x, (h - 1) * w + x]) if (mask[p] && !seen[p]) flood(p);
    for (let y = 0; y < h; y++) for (const p of [y * w, y * w + w - 1]) if (mask[p] && !seen[p]) flood(p);
  }
  // Fill everything enclosed by an outline, so a card whose artwork matches the background is still one solid shape.
  {
    const seen = new Uint8Array(w * h), q = new Int32Array(w * h);
    let qh = 0, qt = 0;
    const push = (p) => { if (!mask[p] && !seen[p]) { seen[p] = 1; q[qt++] = p; } };
    for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
    for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
    while (qh < qt) {
      const p = q[qh++], x = p % w;
      if (x > 0) push(p - 1); if (x < w - 1) push(p + 1);
      if (p >= w) push(p - w); if (p < (h - 1) * w) push(p + w);
    }
    for (let p = 0; p < w * h; p++) if (!seen[p]) mask[p] = 1;
  }
  // Open by 2px: removes specks and cuts thin bridges (shadows, glare, wood grain) between neighbouring cards.
  mask = morph(morph(morph(morph(mask, false), false), true), true);

  // Connected regions.
  const label = new Int32Array(w * h);
  const stack = new Int32Array(w * h);
  const rects = [];
  let next = 0;
  for (let start = 0; start < w * h; start++) {
    if (!mask[start] || label[start]) continue;
    next++;
    let sp = 0, area = 0, x0 = w, y0 = h, x1 = 0, y1 = 0;
    const edge = [];
    stack[sp++] = start; label[start] = next;
    while (sp) {
      const p = stack[--sp];
      area++;
      const x = p % w, y = (p - x) / w;
      let border = x === 0 || y === 0 || x === w - 1 || y === h - 1;
      if (x > 0) { const q = p - 1; if (mask[q]) { if (!label[q]) { label[q] = next; stack[sp++] = q; } } else border = true; }
      if (x < w - 1) { const q = p + 1; if (mask[q]) { if (!label[q]) { label[q] = next; stack[sp++] = q; } } else border = true; }
      if (y > 0) { const q = p - w; if (mask[q]) { if (!label[q]) { label[q] = next; stack[sp++] = q; } } else border = true; }
      if (y < h - 1) { const q = p + w; if (mask[q]) { if (!label[q]) { label[q] = next; stack[sp++] = q; } } else border = true; }
      if (border) { edge.push([x, y]); if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
    if (area < minFrac * w * h || edge.length < 8) continue;
    const r = minAreaRect(convexHull(edge));
    if (!r || r.w < 6) continue;
    rects.push({ cx: (r.cx + 0.5) / k, cy: (r.cy + 0.5) / k, w: (r.w + 1) / k, h: (r.h + 1) / k, angle: r.angle, fit: area / (r.w * r.h), frac: area / (w * h),
      box: { cx: (x0 + x1 + 1) / 2 / k, cy: (y0 + y1 + 1) / 2 / k, w: (x1 - x0 + 1) / k, h: (y1 - y0 + 1) / k, angle: 0 } });
  }
  return rects;
}

const isCardShaped = (r) => r.fit >= 0.75 && Math.abs(r.w / r.h - CARD_ASPECT) <= 0.12;
const sameSpot = (a, b) => Math.hypot(a.cx - b.cx, a.cy - b.cy) < 0.4 * Math.min(a.w, b.w);
function readingOrder(rects) {
  const rowH = rects.length ? Math.min(...rects.map((r) => r.h)) * 0.6 : 1;
  return rects.sort((a, b) => (Math.abs(a.cy - b.cy) > rowH ? a.cy - b.cy : a.cx - b.cx));
}

/**
 * Card-shaped objects in a photo, in reading order: loose cards on a plain surface, or cards in a binder page
 * with visible gaps. (Cards that touch are handled in recognizeMany, which needs the picture index to split them.)
 */
function detectCards(src, { modes = ['ring', 'bright'], ...opts } = {}) {
  const out = [];
  for (const mode of modes) {
    for (const r of detectBlobs(src, { ...opts, mode })) if (isCardShaped(r) && !out.some((o) => sameSpot(o, r))) out.push(r);
  }
  return readingOrder(out);
}

/**
 * Bigger solid shapes that could be several cards touching (a row or block in a binder).
 * `card` is the typical card size seen elsewhere in the photo, if known.
 */
function detectGroups(src, card, taken) {
  const out = [];
  const cardArea = card ? card.w * card.h : 0;
  for (const mode of ['ring', 'bright']) {
    for (const r of detectBlobs(src, { mode })) {
      if (r.fit < 0.6 || r.frac > 0.9) continue;
      if (cardArea ? r.w * r.h < 1.5 * cardArea : isCardShaped(r)) continue;
      if (taken.some((t) => sameSpot(t, r)) || out.some((o) => sameSpot(o, r))) continue;
      out.push(r);
    }
  }
  return out;
}

/** Ways a block could be cut into a grid of cards, best fit first. Each entry is a list of card rectangles. */
function gridSplits(r, card) {
  // Axis A is the block's short side (direction r.angle), axis B its long side.
  const ax = Math.cos(r.angle), ay = Math.sin(r.angle), bx = -ay, by = ax;
  const options = [];
  for (const upright of [true, false]) {          // card width runs along A, or along B
    for (let na = 1; na <= 5; na++) for (let nb = 1; nb <= 5; nb++) {
      if (na * nb < 2 || na * nb > 12) continue;
      const cellA = r.w / na, cellB = r.h / nb;
      const cw = upright ? cellA : cellB, ch = upright ? cellB : cellA;
      let err = Math.abs(cw / ch - CARD_ASPECT) / CARD_ASPECT;
      if (card) err += 0.5 * Math.abs(cw - card.w) / card.w + 0.5 * Math.abs(ch - card.h) / card.h;
      if (err > (card ? 0.45 : 0.16)) continue;
      const cells = [];
      for (let j = 0; j < nb; j++) for (let i = 0; i < na; i++) {
        const u = (i + 0.5) * cellA - r.w / 2, v = (j + 0.5) * cellB - r.h / 2;
        cells.push({ cx: r.cx + u * ax + v * bx, cy: r.cy + u * ay + v * by, w: cw, h: ch, angle: upright ? r.angle : r.angle + Math.PI / 2 });
      }
      options.push({ err, cells });
    }
  }
  return options.sort((p, q) => p.err - q.err).slice(0, 3).map((o) => o.cells);
}

/** Cut a rotated card rectangle out of `src`, upright, with a margin so nearby crops stay inside the picture. */
function rectify(src, r, margin = 0.09) {
  const cw = Math.round(Math.max(300, Math.min(900, r.w)));
  const ch = Math.round(cw * (r.h / r.w));
  const mx = Math.round(cw * margin), my = Math.round(ch * margin);
  const c = document.createElement('canvas');
  c.width = cw + 2 * mx; c.height = ch + 2 * my;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.translate(c.width / 2, c.height / 2);
  ctx.rotate(-r.angle);
  ctx.scale(cw / r.w, cw / r.w);
  ctx.translate(-r.cx, -r.cy);
  ctx.drawImage(src, 0, 0);
  return { canvas: c, x: mx, y: my, w: cw, h: ch };
}

/** The exact card area of a view as its own upright canvas (for text reading). */
function viewCard(view, flip) {
  const c = document.createElement('canvas');
  c.width = view.w; c.height = view.h;
  const ctx = c.getContext('2d');
  if (flip) ctx.setTransform(-1, 0, 0, -1, view.w, view.h);
  ctx.drawImage(view.canvas, view.x, view.y, view.w, view.h, 0, 0, view.w, view.h);
  return c;
}

/* ---------- recognising one card ---------- */

/** Rank index cards against text hints and/or picture distances. Same scoring idea as the online lookup. */
function scoreLocal(index, hints, dist, limit = 18) {
  const { names = [], exactNames = [], num = null, text = '', setName = '' } = hints || {};
  const pool = new Set();
  if (dist) for (const t of topMatches(dist, 15)) pool.add(t.i);
  const target = num ? normLocal((num.prefix || '') + num.n) : null;
  const stems = [...new Set([...exactNames, ...names].flatMap((n) => normText(n).split(' '))
    .filter((w) => w.length >= 3 && !SUFFIX.has(w)).map((w) => (w.length <= 4 ? w : w.slice(0, 5))))];
  if (target || stems.length) {
    for (let i = 0; i < index.n; i++) {
      const c = index.cards[i];
      if ((target && c.ln === target) || stems.some((s) => c.nn.includes(s))) pool.add(i);
    }
  }
  const hay = normText([text, ...names, ...exactNames].join(' '));
  const hayWords = new Set(hay.split(' '));
  const setNorm = normText(setName);
  const ranked = [];
  for (const i of pool) {
    const c = index.cards[i];
    let score = dist ? imgScore(dist[i]) : 0;
    const numHit = target && c.ln === target;
    if (numHit) score += 4;
    if (numHit && num.total && (c.set.cardCount.official === num.total || c.set.cardCount.total === num.total)) score += 6;
    const ns = hay ? nameScore(c.name, hay, exactNames) : 0;
    score += 6 * ns;
    if (ns > 0) for (const w of c.nn.split(' ')) if (SUFFIX.has(w) && w.length >= 2 && hayWords.has(w)) score += 1.5;
    if (setNorm) {
      const sn = normText(c.set.name);
      if (sn === setNorm) score += 3;
      else if (sn.includes(setNorm) || setNorm.includes(sn)) score += 1.5;
    }
    ranked.push({ id: c.id, localId: c.localId, name: c.name, image: c.image, set: c.set, score, d: dist ? dist[i] : null });
  }
  ranked.sort((a, b) => b.score - a.score);
  return ranked.filter((c) => c.score >= 3).slice(0, limit);
}

/**
 * Picture distances for one view of a card. A quick pass over every card with three crops finds the
 * 300 closest, then all 27 crops are tried on just those.
 */
function rankView(index, view, flip, wide = false) {
  const hashes = jitterHashes(view, flip, true, wide);
  // Quick pass: the centred crop at each inset, or (wide) the centre plus one step in each direction.
  const dist = imageRank(index, wide ? [hashes[13], hashes[10], hashes[16], hashes[12], hashes[14]] : [hashes[4], hashes[13], hashes[22]]);
  const order = Array.from({ length: index.n }, (_, i) => i).sort((p, q) => dist[p] - dist[q]);
  let best = Infinity;
  for (let k = 0; k < 300 && k < order.length; k++) {
    const i = order[k];
    dist[i] = distTo(index, i, hashes);
    if (dist[i] < best) best = dist[i];
  }
  return { view, flip, hashes, dist, best };
}

const MIN_TEXT_WIDTH = 700; // below this many pixels across, the collector number is too small to read

/**
 * Recognise the card shown in one or more candidate views (e.g. the detected outline and the on-screen guide).
 * Returns { cands, confidence, d } where cands are ranked matches.
 */
async function recognizeCard(index, views, { allowFlip = false, readText = true, wide = false, flip = null } = {}) {
  const ranked = views.map((view) => {
    if (flip !== null) return rankView(index, view, flip, wide);
    const up = rankView(index, view, false, wide);
    if (!allowFlip || up.best <= 0.2) return up;
    const down = rankView(index, view, true, wide);
    return down.best < up.best ? down : up;
  });
  const dist = ranked[0].dist;
  for (let r = 1; r < ranked.length; r++) { const d2 = ranked[r].dist; for (let i = 0; i < dist.length; i++) if (d2[i] < dist[i]) dist[i] = d2[i]; }
  const verdict = imageVerdict(index, dist);

  // The picture alone settles it: one clear look-alike and no reprints to tell apart.
  if (verdict.decided && verdict.ties.length === 1) {
    return { cands: scoreLocal(index, null, dist), confidence: 'strong', d: verdict.best.d, flip: ranked[0].flip };
  }
  // Otherwise read the text, from whichever view lined up best with the winning picture.
  let hints = null;
  const bestV = ranked.reduce((p, q) => (distTo(index, verdict.best.i, q.hashes) < distTo(index, verdict.best.i, p.hashes) ? q : p));
  if (readText && bestV.view.w >= MIN_TEXT_WIDTH && verdict.best.d <= 0.30) {
    // When the artwork is certain and only the printing is in doubt, the collector number is all that's needed.
    const t = await ocrCard(viewCard(bestV.view, bestV.flip), { quick: true, numberOnly: verdict.decided });
    hints = { names: nameTokens(t.top || ''), num: parseNumber(t.bottom), text: t.top || '' };
  }
  let cands = scoreLocal(index, hints, dist);
  // The artwork is certain but several printings share it: only offer those printings.
  if (verdict.decided && cands.length) {
    const tieIds = new Set(verdict.ties.map((t) => index.cards[t.i].id));
    const tied = cands.filter((c) => tieIds.has(c.id));
    if (tied.length) cands = tied;
  }
  const [a, b2] = cands;
  const confidence = a && a.score >= 9 && (!b2 || a.score - b2.score >= 1.5) ? 'strong' : 'guess';
  return { cands, confidence, d: verdict.best.d, sameArt: verdict.decided, flip: bestV.flip };
}

const MATCH_OK = 0.26; // a found shape counts as a card only if some card's picture is at least this close

/**
 * Recognise every card found in a photo. Returns [{ cands, confidence, rect }] in reading order.
 * Shapes are proposed generously (loose cards, binder pockets, blocks of touching cards) and kept only when
 * they actually look like a known card, so glare patches and empty pockets drop out.
 * Text is not read here: with several cards in view the collector numbers are too small, so reprints that
 * share artwork come back as a best guess for the person to confirm.
 */
async function recognizeMany(index, frame, onProgress) {
  const found = [];
  const tryRect = async (rect, opts) => {
    if (found.some((f) => sameSpot(f.rect, rect))) return null;
    const res = await recognizeCard(index, [rectify(frame, rect)], { allowFlip: true, readText: false, ...opts });
    if (!res.cands.length || res.d > MATCH_OK) return null;
    const hit = { ...res, rect };
    found.push(hit);
    return hit;
  };
  const tick = async (i, n) => { onProgress?.(i, n); await new Promise((r) => setTimeout(r)); }; // let the status line repaint
  const med = (a) => a.slice().sort((p, q) => p - q)[a.length >> 1];

  // 1. Shapes that already look like single cards.
  const singles = detectCards(frame);
  for (let i = 0; i < singles.length; i++) { await tick(i + 1, singles.length); await tryRect(singles[i]); }

  // 2. Blocks of cards that touch each other: cut into a grid and keep the cut whose pieces are recognised.
  const sized = found.length ? found.map((f) => f.rect) : singles;
  const card = sized.length ? { w: med(sized.map((r) => r.w)), h: med(sized.map((r) => r.h)) } : null;
  const groups = detectGroups(frame, card, found.map((f) => f.rect)).sort((p, q) => p.w * p.h - q.w * q.h);
  for (let g = 0; g < groups.length && g < 6; g++) {
    await tick(g + 1, groups.length);
    for (const cells of gridSplits(groups[g], card)) {
      let hits = 0;
      for (const cell of cells) if (await tryRect(cell)) hits++;
      if (hits >= Math.max(1, cells.length / 2)) break;
    }
  }

  // 3. Binder pages and neat rows: cards sit on a regular grid, so look where each found card's neighbours
  //    should be. This picks up dark or shiny cards whose outline blends into the pocket.
  if (found.length) {
    const rects = found.map((f) => f.rect);
    const cw = med(rects.map((r) => r.w)), ch = med(rects.map((r) => r.h));
    // Average direction of the cards' short side (angles are only known up to a half turn, hence the doubling).
    const ang = Math.atan2(rects.reduce((s, r) => s + Math.sin(2 * r.angle), 0), rects.reduce((s, r) => s + Math.cos(2 * r.angle), 0)) / 2;
    const ux = Math.cos(ang), uy = Math.sin(ang), vx = -uy, vy = ux;
    // Spacing between neighbours, measured from pairs already found in the same row or column.
    const pxs = [], pys = [];
    for (let a = 0; a < rects.length; a++) for (let b = a + 1; b < rects.length; b++) {
      const dx = rects[b].cx - rects[a].cx, dy = rects[b].cy - rects[a].cy;
      const du = Math.abs(dx * ux + dy * uy), dv = Math.abs(dx * vx + dy * vy);
      if (dv < 0.35 * ch && du > 0.8 * cw) { const n = Math.round(du / (1.07 * cw)); if (n >= 1) pxs.push(du / n); }
      if (du < 0.35 * cw && dv > 0.8 * ch) { const n = Math.round(dv / (1.05 * ch)); if (n >= 1) pys.push(dv / n); }
    }
    const px = Math.min(1.3 * cw, Math.max(cw, pxs.length ? med(pxs) : 1.07 * cw));
    const py = Math.min(1.25 * ch, Math.max(ch, pys.length ? med(pys) : 1.05 * ch));
    const flip = found.filter((f) => f.flip).length > found.length / 2;
    const probed = [];
    const queue = found.slice();
    let budget = 28;
    while (queue.length && budget > 0) {
      const f = queue.shift();
      for (const [i, j] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const rect = { cx: f.rect.cx + i * px * ux + j * py * vx, cy: f.rect.cy + i * px * uy + j * py * vy, w: cw, h: ch, angle: ang };
        if (rect.cx < cw * 0.45 || rect.cy < ch * 0.45 || rect.cx > frame.width - cw * 0.45 || rect.cy > frame.height - ch * 0.45) continue;
        if (found.some((o) => sameSpot(o.rect, rect)) || probed.some((o) => sameSpot(o, rect))) continue;
        probed.push(rect);
        if (--budget < 0) break;
        await tick(found.length, found.length);
        const hit = await tryRect(rect, { wide: true, flip });
        if (hit) queue.push(hit);
      }
    }
  }
  return readingOrder(found.map((f) => f.rect)).map((r) => found.find((f) => f.rect === r));
}

/* ---------- sealed product from its picture ---------- */

const SEALED_REC = 144;
let sealedPicsPromise = null;
function getSealedPics() {
  if (!sealedPicsPromise) {
    sealedPicsPromise = (async () => {
      const [meta, buf, sealed] = await Promise.all([
        getJSON('data/sealed_pics.json'),
        fetch('data/sealed_pics.bin').then((r) => { if (!r.ok) throw new Error('Could not load the sealed pictures index.'); return r.arrayBuffer(); }),
        getSealed(),
      ]);
      if (buf.byteLength !== meta.pids.length * SEALED_REC) throw new Error('The sealed pictures index is out of sync. Reload the page.');
      const byPid = new Map(sealed.products.map((p) => [p.pid, p]));
      const bytes = new Uint8Array(buf), words = new Uint32Array(buf);
      const maskBits = new Uint16Array(meta.pids.length);
      for (let k = 0; k < meta.pids.length; k++) {
        let n = 0;
        for (let j = 16; j < 32; j++) n += pop32(words[k * 36 + j]);
        maskBits[k] = Math.max(n, 1);
      }
      return { pids: meta.pids, byPid, bytes, words, maskBits, n: meta.pids.length };
    })().catch((e) => { sealedPicsPromise = null; throw e; });
  }
  return sealedPicsPromise;
}

const hueCanvas = document.createElement('canvas');
hueCanvas.width = hueCanvas.height = 48;
const hueCtx = hueCanvas.getContext('2d', { willReadFrequently: true });

/** Hue histogram of a view (12 bins of saturated pixels, lightly smoothed, scaled to 0-255). Matches build_sealed_pics.py. */
function hueHist(view) {
  hueCtx.imageSmoothingQuality = 'high';
  hueCtx.drawImage(view.canvas, view.x, view.y, view.w, view.h, 0, 0, 48, 48);
  const d = hueCtx.getImageData(0, 0, 48, 48).data;
  const bins = new Float32Array(12);
  let total = 0;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), df = mx - mn;
    if (mx < 0.2 || df / (mx || 1) < 0.25) continue;
    let h = mx === r ? ((g - b) / df) % 6 : mx === g ? (b - r) / df + 2 : (r - g) / df + 4;
    h /= 6; if (h < 0) h += 1;
    bins[Math.floor(h * 12) % 12]++; total++;
  }
  const out = new Uint8Array(12);
  if (total < 0.05 * 48 * 48) return out;
  for (let i = 0; i < 12; i++) out[i] = Math.min(255, Math.round((0.5 * bins[i] + 0.25 * bins[(i + 11) % 12] + 0.25 * bins[(i + 1) % 12]) / total * 255));
  return out;
}

/** Rank sealed products by how much they look like the object in `view`: artwork layout, colours and shape. */
function rankSealedPicture(pics, view) {
  const qs = [];
  hashCtx.imageSmoothingEnabled = true;
  hashCtx.imageSmoothingQuality = 'high';
  hashCtx.setTransform(1, 0, 0, 1, 0, 0);
  for (const s of [-0.04, 0, 0.04]) for (const dx of [-0.03, 0, 0.03]) for (const dy of [-0.03, 0, 0.03]) {
    hashCtx.drawImage(view.canvas, view.x + view.w * (s + dx), view.y + view.h * (s + dy), view.w * (1 - 2 * s), view.h * (1 - 2 * s), 0, 0, 128, 128);
    // A box can be lying any way up, so try all four quarter-turns of each crop.
    let g = gridFromCanvas();
    for (let t = 0; t < 4; t++) { qs.push(bitsFromGrid(g)); g = rotateGrid(g); }
  }
  const hist = hueHist(view);
  const histSum = hist.reduce((a, b) => a + b, 0);
  const aspect = Math.min(view.w, view.h) / Math.max(view.w, view.h);
  const ranked = [];
  for (let k = 0; k < pics.n; k++) {
    const p = pics.byPid.get(pics.pids[k]);
    if (!p) continue;
    const o = k * 36, ob = k * SEALED_REC;
    let best = 1e9;
    for (const h of qs) {
      let x = 0;
      for (let j = 0; j < 15; j++) x += pop32((h[j] ^ pics.words[o + j]) & pics.words[o + 16 + j]);
      if (x < best) best = x;
    }
    const d = best / pics.maskBits[k];
    let inter = 0, refSum = 0;
    for (let i = 0; i < 12; i++) { const r = pics.bytes[ob + 128 + i]; refSum += r; inter += Math.min(r, hist[i]); }
    const histSim = histSum && refSum ? inter / Math.max(histSum, refSum) : 0.5;
    const aspectSim = Math.max(0, 1 - Math.abs(aspect - pics.bytes[ob + 143] / 255) / 0.2);
    const hashSim = Math.max(0, Math.min(1, 1 - (d - 0.10) / 0.30));
    const score = 0.6 * hashSim + 0.25 * histSim + 0.15 * aspectSim;
    ranked.push({ ...p, score, d, exact: false });
  }
  ranked.sort((a, b) => b.score - a.score);
  return ranked.slice(0, 15);
}

/** Recognise a sealed product in a photo. Returns ranked products, each with .score and .d (picture distance). */
async function readSealed(frame) {
  const pics = await getSealedPics();
  // The product is the biggest solid thing in view; failing that, assume it fills the photo.
  const blob = detectBlobs(frame, { minFrac: 0.06 }).filter((r) => r.fit >= 0.55).sort((a, b) => b.frac - a.frac)[0];
  const views = [];
  if (blob) { views.push(rectify(frame, blob, 0.09)); views.push(rectify(frame, blob.box, 0.09)); }
  views.push(rectify(frame, { cx: frame.width / 2, cy: frame.height / 2, w: frame.width * 0.88, h: frame.height * 0.88, angle: 0 }, 0.06));
  const merged = new Map();
  for (const view of views) for (const p of rankSealedPicture(pics, view)) {
    const prev = merged.get(p.pid);
    if (!prev || p.score > prev.score) merged.set(p.pid, p);
  }
  return [...merged.values()].sort((a, b) => b.score - a.score).slice(0, 12);
}

const sealedPictureConfidence = (c) => (c.length && c[0].d <= 0.2 && (!c[1] || c[0].score - c[1].score >= 0.06) ? 'strong' : 'guess');

// Fetch the picture indexes in the background so the first scan doesn't wait for them.
getIndex().catch(() => {});
getSealedPics().catch(() => {});
