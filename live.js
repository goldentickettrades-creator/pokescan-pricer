'use strict';
/*
 * Live scanning: recognise cards continuously from the camera and pin each card's price on top of it.
 * No button press and no photo. Loaded after app.js and vision.js.
 *
 * Each pass looks at one camera frame:
 *   1. find card outlines and match them to the cards already being followed ("tracks");
 *   2. recognise outlines that are new;
 *   3. re-check followed cards whose outline wasn't seen this time;
 *   4. on binder pages, look where the neighbours of followed cards should be;
 *   5. redraw the price tags.
 * Recognition work per pass is capped so the screen stays responsive; anything left over waits for the next pass.
 */

const LIVE_FRAME_MAX = 1920;   // working size of each camera frame (long side)
const LIVE_BUDGET_MS = 200;    // recognition work per pass
const LIVE_KEEP_MS = 1800;     // a card that drops out of sight keeps its tag this long, to hide flicker
const LIVE_REJECT_MS = 5000;   // don't re-test a spot that wasn't a card for this long

const live = {
  running: false,
  tracks: [],        // cards currently followed
  rejected: [],      // spots tested recently that were not a card: { rect, at }
  seq: 0,
  canvas: document.createElement('canvas'),
  scale: 1,          // live frame pixels per video pixel
  recent: [],        // cards that just left the view, so they are recognised instantly if they come back
  reviewing: [],     // tracks handed to the review list
  openKey: null,     // track whose sheet is open
  lastEnd: 0,        // when the previous pass finished
  pass: 0,
};

function liveActive() {
  return state.mode === 'live' && !!state.stream && !state.busy && !state.card && !state.sealed && !document.hidden
    && els.video.videoWidth > 0 && els.still.hidden && !els.settings.open
    && [els.chooser, els.searchPanel, els.batchPanel, els.binderPanel].every((p) => p.hidden);
}

async function liveStart() {
  if (live.running) return;
  live.running = true;
  try {
    while (state.stream && state.mode === 'live') {
      const active = liveActive();
      if (active) { try { await livePass(); } catch (e) { console.warn('live pass failed', e); } }
      await new Promise((r) => setTimeout(r, active ? 90 : 350));
    }
  } finally {
    live.running = false;
    liveClear();
  }
}

function liveClear() {
  live.tracks = [];
  live.rejected = [];
  liveRender();
}

function liveFrame() {
  const v = els.video;
  const s = Math.min(1, LIVE_FRAME_MAX / Math.max(v.videoWidth, v.videoHeight));
  const w = Math.round(v.videoWidth * s), h = Math.round(v.videoHeight * s);
  if (live.canvas.width !== w || live.canvas.height !== h) { live.canvas.width = w; live.canvas.height = h; }
  live.canvas.getContext('2d', { willReadFrequently: true }).drawImage(v, 0, 0, w, h);
  live.scale = s;
  return live.canvas;
}

const LIVE_SAME = 0.30;        // a followed card still looks like itself up to this picture distance
const LIVE_DIFFERENT = 0.34;   // beyond this it is clearly something else

/** How far the picture at `rect` is from the card a track is following (one quick crop, more only if needed). */
function liveStillThere(index, frame, track, rect) {
  const view = rectify(frame, rect);
  const d = distTo(index, track.idx, [cardHash(view.canvas, view.x, view.y, view.w, view.h, track.flip)]);
  return d <= 0.26 ? d : Math.min(d, distTo(index, track.idx, jitterHashes(view, track.flip)));
}

const liveNear = (a, b) => Math.hypot(a.cx - b.cx, a.cy - b.cy) < 0.45 * Math.min(a.w, b.w);

/** Grid spacing and direction implied by a set of card rectangles (binder pages, neat rows). */
function gridGeometry(rects) {
  const med = (a) => a.slice().sort((p, q) => p - q)[a.length >> 1];
  const cw = med(rects.map((r) => r.w)), ch = med(rects.map((r) => r.h));
  // Average direction of the cards' short side (angles are only known up to a half turn, hence the doubling).
  const ang = Math.atan2(rects.reduce((s, r) => s + Math.sin(2 * r.angle), 0), rects.reduce((s, r) => s + Math.cos(2 * r.angle), 0)) / 2;
  const ux = Math.cos(ang), uy = Math.sin(ang), vx = -uy, vy = ux;
  const pxs = [], pys = [];
  for (let a = 0; a < rects.length; a++) for (let b = a + 1; b < rects.length; b++) {
    const dx = rects[b].cx - rects[a].cx, dy = rects[b].cy - rects[a].cy;
    const du = Math.abs(dx * ux + dy * uy), dv = Math.abs(dx * vx + dy * vy);
    if (dv < 0.35 * ch && du > 0.8 * cw) { const n = Math.round(du / (1.07 * cw)); if (n >= 1) pxs.push(du / n); }
    if (du < 0.35 * cw && dv > 0.8 * ch) { const n = Math.round(dv / (1.05 * ch)); if (n >= 1) pys.push(dv / n); }
  }
  const px = Math.min(1.3 * cw, Math.max(cw, pxs.length ? med(pxs) : 1.07 * cw));
  const py = Math.min(1.25 * ch, Math.max(ch, pys.length ? med(pys) : 1.05 * ch));
  return { cw, ch, ang, ux, uy, vx, vy, px, py };
}

/** Is there anything card-like at `rect`? Adds a track and returns it, or remembers the spot as empty. */
async function liveIdentify(index, frame, rect, { wide = false, flip = null } = {}) {
  const now = performance.now();
  const view = rectify(frame, rect);
  // Quick outs: a flat patch (table, empty pocket) is not a card.
  hashCtx.setTransform(1, 0, 0, 1, 0, 0);
  hashCtx.drawImage(view.canvas, view.x, view.y, view.w, view.h, 0, 0, 128, 128);
  const g = gridFromCanvas();
  let mean = 0; for (let i = 0; i < 256; i++) mean += g[i]; mean /= 256;
  let sd = 0; for (let i = 0; i < 256; i++) sd += (g[i] - mean) ** 2; sd = Math.sqrt(sd / 256);
  let res = null;
  if (sd >= 10) {
    // A card that was on screen a moment ago is usually the same card after the camera moves: check those first.
    const hashes = {};
    for (const t of live.tracks.concat(live.recent)) {
      if (flip !== null && t.flip !== flip) continue;
      const d = distTo(index, t.idx, hashes[t.flip] || (hashes[t.flip] = jitterHashes(view, t.flip, true, wide)));
      if (d <= 0.2 && (!res || d < res.d)) res = { cands: t.cands, confidence: t.confidence, sameArt: t.sameArt, flip: t.flip, d };
    }
    if (!res) res = await recognizeCard(index, [view], { allowFlip: flip === null, flip, wide, readText: false });
  }
  if (!res || !res.cands.length || res.d > MATCH_OK) {
    live.rejected.push({ rect, at: now });
    return null;
  }
  const top = res.cands[0];
  const track = {
    key: ++live.seq, rect, flip: !!res.flip, idx: index.byId.get(top.id), id: top.id, name: top.name,
    cands: res.cands, confidence: res.confidence, sameArt: !!res.sameArt,
    seen: now, checked: now, miss: 0, usd: null, eur: null, priced: false, done: false, textTried: false,
  };
  // A card that blinked out of view and straight back is the same card: keep its "added" tick.
  const back = live.recent.findIndex((r) => r.done && r.id === track.id && now - r.goneAt < 4000);
  if (back >= 0) { track.done = true; live.recent.splice(back, 1); }
  live.tracks.push(track);
  livePrice(track);
  return track;
}

/** Look the card's price up (cached) and attach it to the track. */
function livePrice(track) {
  getCard(track.id).then((card) => {
    const printing = printingsOf(card)[0] || null;
    const v = valuesFor(card, printing);
    Object.assign(track, { card, printing, usd: v.usd, eur: v.eur, priced: true });
    liveRender();
  }).catch(() => { setTimeout(() => { if (live.tracks.includes(track)) livePrice(track); }, 3000); }); // price service busy: try again shortly
}

/** One large card that has same-art reprints: read its collector number once to settle the printing. */
function liveReadNumber(index, frame, track) {
  track.textTried = true;
  const view = rectify(frame, track.rect); // copied out now; the frame canvas is reused by the next pass
  recognizeCard(index, [view], { flip: track.flip, readText: true }).then((res) => {
    if (res.confidence !== 'strong' || !res.cands.length || !live.tracks.includes(track)) return;
    const top = res.cands[0];
    Object.assign(track, { cands: res.cands, confidence: 'strong', id: top.id, name: top.name, idx: index.byId.get(top.id), priced: false, usd: null, eur: null });
    livePrice(track);
  }).catch(() => {});
}

async function livePass() {
  const index = await getIndex();
  const frame = liveFrame();
  const now = performance.now();
  const deadline = now + LIVE_BUDGET_MS;
  const late = () => performance.now() > deadline;
  // Time spent paused (a result or the review list was open) doesn't count as "not seen".
  const gap = live.lastEnd ? now - live.lastEnd : 0;
  if (gap > 500) {
    for (const t of live.tracks) t.seen += gap;
    for (const r of live.rejected) r.at += gap;
    for (const t of live.recent) t.goneAt += gap;
  }
  live.rejected = live.rejected.filter((r) => now - r.at < LIVE_REJECT_MS);

  // 1. Outlines in this frame, matched to the cards already followed. The two ways of finding outlines take
  //    turns, which halves the work per pass; followed cards carry over between passes either way.
  const shapes = detectCards(frame, { modes: [live.pass++ % 2 ? 'bright' : 'ring'] });
  const fresh = [];
  const shifts = [];
  for (const s of shapes) {
    const t = live.tracks.find((x) => x.seen !== now && liveNear(x.rect, s));
    if (!t) { if (!live.rejected.some((r) => sameSpot(r.rect, s))) fresh.push(s); continue; }
    // Same place is not enough: the card may have been swapped (flipping through a stack). Check the picture too.
    const d = liveStillThere(index, frame, t, s);
    if (d <= LIVE_SAME) { shifts.push([s.cx - t.rect.cx, s.cy - t.rect.cy]); t.rect = s; t.seen = now; t.miss = 0; continue; }
    // The new outline may just be a poor one (shadow, glare). If the card still matches where it was, keep it there.
    const own = liveStillThere(index, frame, t, t.rect);
    if (own <= LIVE_SAME) { t.seen = now; t.miss = 0; }
    else if (Math.min(d, own) > LIVE_DIFFERENT || ++t.miss >= 2) { live.tracks.splice(live.tracks.indexOf(t), 1); fresh.push(s); }
  }
  // The camera moved: carry the cards that weren't re-outlined (and the "not a card" spots) along with the rest.
  if (shifts.length) {
    const med = (a) => a.sort((p, q) => p - q)[a.length >> 1];
    const dx = med(shifts.map((s) => s[0])), dy = med(shifts.map((s) => s[1]));
    if (Math.hypot(dx, dy) > 2) {
      for (const t of live.tracks) if (t.seen !== now) t.rect = { ...t.rect, cx: t.rect.cx + dx, cy: t.rect.cy + dy };
      for (const r of live.rejected) r.rect = { ...r.rect, cx: r.rect.cx + dx, cy: r.rect.cy + dy };
    }
  }

  // 2. New outlines, biggest first.
  fresh.sort((a, b) => b.w * b.h - a.w * a.h);
  for (const s of fresh) { if (late()) break; await liveIdentify(index, frame, s); }

  // 3. Followed cards whose outline wasn't seen this pass: is the same picture still there?
  const stale = live.tracks.filter((t) => t.seen !== now).sort((a, b) => a.checked - b.checked);
  for (const t of stale) {
    if (late()) break;
    t.checked = performance.now();
    const d = distTo(index, t.idx, jitterHashes(rectify(frame, t.rect), t.flip, true, true));
    if (d <= LIVE_SAME) { t.seen = now; t.miss = 0; } else if (d > LIVE_DIFFERENT) t.miss = 2; else t.miss++;
  }

  // 4. Binder pages: where each followed card's neighbours should be.
  const anchors = live.tracks.filter((t) => t.seen === now);
  if (anchors.length && !late()) {
    const g = gridGeometry(anchors.map((t) => t.rect));
    const flip = anchors.filter((t) => t.flip).length > anchors.length / 2;
    outer: for (const t of anchors) {
      for (const [i, j] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const rect = { cx: t.rect.cx + i * g.px * g.ux + j * g.py * g.vx, cy: t.rect.cy + i * g.px * g.uy + j * g.py * g.vy, w: g.cw, h: g.ch, angle: g.ang };
        if (rect.cx < g.cw * 0.45 || rect.cy < g.ch * 0.45 || rect.cx > frame.width - g.cw * 0.45 || rect.cy > frame.height - g.ch * 0.45) continue;
        if (live.tracks.some((o) => liveNear(o.rect, rect)) || live.rejected.some((r) => sameSpot(r.rect, rect))) continue;
        if (late()) break outer;
        await liveIdentify(index, frame, rect, { wide: true, flip });
      }
    }
  }

  // 4b. Nothing found at all: maybe one card is being held up inside the corner marks.
  if (!live.tracks.length && !fresh.length && !late()) {
    const gf = guideInFrame();
    const rect = { cx: (gf.x + gf.w / 2) * live.scale, cy: (gf.y + gf.h / 2) * live.scale, w: gf.w * live.scale, h: gf.h * live.scale, angle: 0 };
    if (!live.rejected.some((r) => sameSpot(r.rect, rect))) {
      const t = await liveIdentify(index, frame, rect, { wide: true, flip: false });
      if (!t) live.rejected[live.rejected.length - 1].at = now - LIVE_REJECT_MS + 900; // try the guide again in about a second
    }
  }

  // 5. Let go of cards that left the view; remember them briefly so they are recognised instantly if they come back.
  const gone = live.tracks.filter((t) => t.miss >= 2 || now - t.seen > LIVE_KEEP_MS);
  if (gone.length) {
    for (const t of gone) t.goneAt = now;
    live.recent = gone.concat(live.recent).slice(0, 24);
    live.tracks = live.tracks.filter((t) => !gone.includes(t));
  }

  // One or two big cards with look-alike reprints: read the number to pick the printing.
  if (live.tracks.length <= 2) {
    for (const t of live.tracks) if (t.sameArt && t.confidence !== 'strong' && !t.textTried && t.rect.w >= MIN_TEXT_WIDTH) liveReadNumber(index, frame, t);
  }
  liveRender();
  live.lastEnd = performance.now();
}

/* ---------- price tags ---------- */

const liveMoney = (t) => {
  const v = source() === 'cm' ? t.eur : t.usd, sym = source() === 'cm' ? '€' : '$';
  if (v == null) return null;
  return sym + (v >= 100 ? Math.round(v).toLocaleString('en-US') : v.toFixed(2));
};

function liveTotals() {
  const open = live.tracks.filter((t) => !t.done);
  const total = open.reduce((s, t) => s + ((source() === 'cm' ? t.eur : t.usd) ?? 0), 0);
  return { open, total, text: (source() === 'cm' ? eur : usd)(total) };
}

function liveRender() {
  const layer = els.liveLayer;
  if (!layer) return;
  const show = state.mode === 'live' && !!state.stream && els.still.hidden;
  const tracks = show ? live.tracks : [];
  els.stage.classList.toggle('live-empty', show && !tracks.length);

  const v = els.video, box = els.stage.getBoundingClientRect();
  const cover = v.videoWidth ? Math.max(box.width / v.videoWidth, box.height / v.videoHeight) : 1;
  const ox = (box.width - v.videoWidth * cover) / 2, oy = (box.height - v.videoHeight * cover) / 2;
  const m = cover / live.scale;

  const have = new Map([...layer.children].map((el) => [el.dataset.key, el]));
  for (const t of tracks) {
    let el = have.get(String(t.key));
    if (!el) {
      el = document.createElement('button');
      el.type = 'button';
      el.className = 'live-card';
      el.dataset.key = t.key;
      el.innerHTML = '<span class="live-tag"><b></b><small></small></span>';
      layer.appendChild(el);
    }
    have.delete(String(t.key));
    const w = t.rect.w * m, h = t.rect.h * m;
    el.style.width = w + 'px';
    el.style.height = h + 'px';
    el.style.transform = `translate(${t.rect.cx * m + ox - w / 2}px, ${t.rect.cy * m + oy - h / 2}px) rotate(${t.rect.angle}rad)`;
    const price = liveMoney(t);
    const unsure = t.confidence !== 'strong';
    el.classList.toggle('unsure', unsure && !t.done);
    el.classList.toggle('done', t.done);
    el.classList.toggle('small', w < 96);
    el.querySelector('b').textContent = t.done ? '✓ ' + (price || 'added') : !t.priced ? '…' : (price || 'no price') + (unsure ? ' ?' : '');
    el.querySelector('small').textContent = t.name;
    el.setAttribute('aria-label', `${t.name}, ${price || 'price not available'}${unsure ? ', printing not certain' : ''}. Open details.`);
  }
  for (const el of have.values()) el.remove();

  // Status line and main button follow what is in view.
  if (show && !state.busy) {
    const { open, text } = liveTotals();
    if (tracks.length) setStatus(open.length ? `${open.length} card${open.length === 1 ? '' : 's'} in view · ${text}` : 'All added. Move on to the next cards.');
    else setStatus('Point at your cards. Prices appear on them.');
  }
  renderDock();
}

/* ---------- acting on what is in view ---------- */

/** Open one followed card's full result (printing, both markets, add to binder). */
async function liveOpen(key) {
  const t = live.tracks.find((x) => String(x.key) === String(key));
  if (!t) return;
  live.openKey = t.key;
  state.candidates = t.cands;
  state.confidence = t.confidence === 'strong' ? 'strong' : 'guess';
  try {
    await openCard(t.id);
    if (state.confidence === 'guess' && t.cands.length > 1) openCardChooser(true);
  } catch (e) { setStatus(e.message, { error: true }); }
}

/** Put every card in view into the review list, ready to add in one tap. */
function liveReview() {
  const { open } = liveTotals();
  if (!open.length) return;
  live.reviewing = open;
  showBatch(open.map((t) => ({ kind: 'card', label: t.name, query: '', cands: t.cands, sure: t.confidence === 'strong' })));
}

/** Called after cards were added to the binder, so their tags turn into ticks instead of being offered again. */
function liveMarkAdded(what) {
  if (what === 'review') for (const t of live.reviewing) t.done = true;
  if (what === 'open') { const t = live.tracks.find((x) => x.key === live.openKey); if (t) t.done = true; }
  live.reviewing = [];
  live.openKey = null;
  liveRender();
}

els.liveLayer?.addEventListener('click', (ev) => {
  const el = ev.target.closest('.live-card');
  if (el) liveOpen(el.dataset.key);
});
window.addEventListener('resize', liveRender);

// All scripts are loaded: open straight into the camera if the person already allowed it here before.
(async () => {
  let granted = false;
  try { granted = (await navigator.permissions?.query({ name: 'camera' }))?.state === 'granted'; } catch { /* unsupported */ }
  if (granted || storageGet('pokescan.camOk', false)) startCamera();
})();
