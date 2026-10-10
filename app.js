'use strict';

const API = 'https://api.tcgdex.net/v2/en';
const CLAUDE_MODEL = 'claude-opus-5-5';
const EUR_TO_USD = 1.08; // only used to sort and filter, never shown as a converted price
const $ = (s) => document.querySelector(s);

const els = {
  app: $('#app'), stage: $('#stage'), video: $('#video'), still: $('#still'), guide: $('#guide'),
  stageEmpty: $('#stageEmpty'), demoBtn: $('#demoBtn'),
  statusPill: $('#statusPill'), statusText: $('#statusText'), helpBtn: $('#helpBtn'),
  sheet: $('#sheet'), sheetBody: $('#sheetBody'),
  strip: $('#strip'), stripMain: $('#stripMain'), stripLabel: $('#stripLabel'), stripTotal: $('#stripTotal'), undoBtn: $('#undoBtn'),
  dockReady: $('#dockReady'), dockResult: $('#dockResult'), scanBtn: $('#scanBtn'), searchBtn: $('#searchBtn'),
  skipBtn: $('#skipBtn'), addBtn: $('#addBtn'), fileInput: $('#fileInput'),
  chooser: $('#chooser'), chooserList: $('#chooserList'), chooserNote: $('#chooserNote'),
  searchPanel: $('#searchPanel'), searchForm: $('#searchForm'), searchInput: $('#searchInput'), searchList: $('#searchList'), searchNote: $('#searchNote'),
  binderPanel: $('#binderPanel'), binderBody: $('#binderBody'),
  lightbox: $('#lightbox'), lightboxImg: $('#lightboxImg'),
  settings: $('#settings'), settingsBtn: $('#settingsBtn'), apiKey: $('#apiKey'), soundOpt: $('#soundOpt'),
};

const state = {
  stream: null,
  busy: false,
  saving: false,
  card: null,            // full TCGdex card on the sheet
  printing: null,        // chosen printing key, or null when the person still has to choose
  candidates: [],
  confidence: null,      // 'strong' | 'guess' | 'picked' | 'demo'
  detailsOpen: false,
  collection: loadCollection(),
  lastAdd: null,
  undoTimer: null,
  scans: storageGet('pokescan.scans', 0),
};

/* ---------- helpers ---------- */

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const fmt = (n) => Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const usd = (n) => (n == null || isNaN(n) ? '—' : '$' + fmt(n));
const eur = (n) => (n == null || isNaN(n) ? '—' : '€' + fmt(n));

function storageGet(k, fallback) {
  try { const v = localStorage.getItem(k); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
}
function storageSet(k, v) {
  try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ }
}
function loadCollection() {
  const col = storageGet('pokescan.collection', []);
  // Earlier versions stored the printing as `variant`.
  for (const e of col) if (e.printing === undefined && e.variant !== undefined) { e.printing = e.variant; delete e.variant; }
  return col;
}
function saveCollection() { storageSet('pokescan.collection', state.collection); }
const apiKey = () => storageGet('pokescan.apiKey', '');
const source = () => storageGet('pokescan.source', 'tcg'); // 'tcg' | 'cm'
const soundOn = () => storageGet('pokescan.sound', false);

async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`The card database returned an error (${r.status}). Try again in a moment.`);
  return r.json();
}

function setStatus(msg, { busy = false, error = false } = {}) {
  els.statusPill.hidden = !msg;
  els.statusPill.classList.toggle('error', error);
  els.statusPill.innerHTML = (busy ? '<span class="spin"></span>' : '') + `<span>${esc(msg)}</span>`;
}
function idleStatus() {
  setStatus(state.stream ? 'Fit the whole card inside the frame.' : '');
}

const imgUrl = (base, q = 'high') => (base ? `${base}/${q}.webp` : '');
const setIdOf = (cardId) => cardId.slice(0, cardId.lastIndexOf('-'));
const isPocket = (c) => (c.image || '').includes('/tcgp/') || /^(A\d|B\d|P-[AB])/.test(setIdOf(c.id));

let setsPromise = null;
function getSets() {
  if (!setsPromise) {
    setsPromise = getJSON(`${API}/sets`).then((arr) => new Map(arr.map((s) => [s.id, s]))).catch((e) => { setsPromise = null; throw e; });
  }
  return setsPromise;
}

function haptic() { try { navigator.vibrate?.(14); } catch { /* unsupported */ } }

let audioCtx = null;
function chime() {
  if (!soundOn()) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const t = audioCtx.currentTime;
    [880, 1320].forEach((f, i) => {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t + i * 0.07);
      g.gain.exponentialRampToValueAtTime(0.12, t + i * 0.07 + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.07 + 0.16);
      o.connect(g).connect(audioCtx.destination);
      o.start(t + i * 0.07); o.stop(t + i * 0.07 + 0.18);
    });
  } catch { /* audio unavailable */ }
}
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ---------- camera ---------- */

async function startCamera() {
  stopCamera();
  if (!navigator.mediaDevices?.getUserMedia) {
    setStatus('This browser cannot open the camera here. Use Upload instead.', { error: true });
    return;
  }
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false,
    });
    els.video.srcObject = state.stream;
    await els.video.play();
    els.stageEmpty.hidden = true;
    els.still.hidden = true;
    els.video.hidden = false;
    els.guide.hidden = false;
    storageSet('pokescan.camOk', true);
    // Show the name/number zones for the first couple of scans, then keep the frame calm.
    setHelp(state.scans < 2);
    idleStatus();
  } catch (e) {
    const denied = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
    setStatus(denied ? 'Camera blocked. Allow it in your browser settings, or use Upload.' : 'No camera found. Use Upload or Search.', { error: true });
  }
  renderDock();
}

function stopCamera() {
  if (state.stream) state.stream.getTracks().forEach((t) => t.stop());
  state.stream = null;
}

function setHelp(on) {
  els.guide.classList.toggle('help', on);
  els.helpBtn.setAttribute('aria-pressed', String(on));
}

/** Crop the area inside the on-screen card guide out of the live video frame. */
function grabFrame() {
  const v = els.video, vw = v.videoWidth, vh = v.videoHeight;
  const box = els.stage.getBoundingClientRect();
  const g = els.guide.getBoundingClientRect();
  const scale = Math.max(box.width / vw, box.height / vh); // object-fit: cover
  const ox = (box.width - vw * scale) / 2, oy = (box.height - vh * scale) / 2;
  const pad = 0.03;
  let sx = (g.left - box.left - ox) / scale - (g.width / scale) * pad;
  let sy = (g.top - box.top - oy) / scale - (g.height / scale) * pad;
  let sw = (g.width / scale) * (1 + 2 * pad), sh = (g.height / scale) * (1 + 2 * pad);
  sx = Math.max(0, sx); sy = Math.max(0, sy);
  sw = Math.min(vw - sx, sw); sh = Math.min(vh - sy, sh);
  const c = document.createElement('canvas');
  c.width = Math.round(sw); c.height = Math.round(sh);
  c.getContext('2d').drawImage(v, sx, sy, sw, sh, 0, 0, c.width, c.height);
  return c;
}

/* ---------- OCR (on-device, Tesseract) ---------- */

let workerPromise = null;
function getWorker() {
  if (!workerPromise) {
    workerPromise = Tesseract.createWorker('eng', 1).catch((e) => { workerPromise = null; throw e; });
  }
  return workerPromise;
}

/** Cut a horizontal band out of the card image, upscale it and boost contrast for OCR. */
function band(src, y0, y1, x0 = 0, x1 = 1, targetW = 1600) {
  const sw = src.width * (x1 - x0), sh = src.height * (y1 - y0);
  const k = targetW / sw;
  const c = document.createElement('canvas');
  c.width = Math.round(targetW); c.height = Math.max(1, Math.round(sh * k));
  const ctx = c.getContext('2d');
  ctx.filter = 'grayscale(1) contrast(1.7)';
  ctx.drawImage(src, src.width * x0, src.height * y0, sw, sh, 0, 0, c.width, c.height);
  return c;
}

async function ocrCard(canvas) {
  const worker = await getWorker();
  const out = {};
  for (const [key, img] of [
    ['top', band(canvas, 0, 0.14, 0, 0.78)],
    ['bottom', band(canvas, 0.84, 1, 0, 1)],
    ['full', band(canvas, 0, 1, 0, 1, 1200)],
  ]) {
    const { data } = await worker.recognize(img);
    out[key] = data.text || '';
  }
  return out;
}

/* ---------- Claude vision (optional) ---------- */

const CARD_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['is_pokemon_card', 'name', 'number', 'set_name'],
  properties: {
    is_pokemon_card: { type: 'boolean' },
    name: { type: 'string', description: 'Card name exactly as printed, including suffixes like ex, V, VMAX, VSTAR, GX' },
    number: { type: 'string', description: 'Collector number as printed, e.g. 025/198, TG05/TG30, SWSH050, or empty if unreadable' },
    set_name: { type: 'string', description: 'English set name if you can tell from the set symbol or text, else empty' },
  },
};
const CARD_PROMPT = 'This photo should show a single Pokémon Trading Card Game card. Read the card name and the collector number printed in the bottom corner. If a field is unreadable, return an empty string for it.';

/** JPEG base64 of the card, downscaled to keep requests small (text stays legible). */
function jpegB64(canvas, maxSide = 1400) {
  let src = canvas;
  const big = Math.max(canvas.width, canvas.height);
  if (big > maxSide) {
    const k = maxSide / big;
    src = document.createElement('canvas');
    src.width = Math.round(canvas.width * k); src.height = Math.round(canvas.height * k);
    src.getContext('2d').drawImage(canvas, 0, 0, src.width, src.height);
  }
  return src.toDataURL('image/jpeg', 0.88).split(',')[1];
}

async function claudeIdentify(canvas) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey(),
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
      'anthropic-beta': 'server-side-fallback-2026-07-01',
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 4000,
      output_config: { effort: 'low', format: { type: 'json_schema', schema: CARD_SCHEMA } },
      fallbacks: 'default',
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: jpegB64(canvas) } },
          { type: 'text', text: CARD_PROMPT },
        ],
      }],
    }),
  });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).error?.message || ''; } catch { /* ignore */ }
    if (res.status === 401) throw new Error('Your Anthropic API key was rejected. Check it in Settings.');
    throw new Error(`Claude request failed (${res.status}) ${detail}`.trim());
  }
  const msg = await res.json();
  if (msg.stop_reason === 'refusal') throw new Error('Claude declined to read this image.');
  const text = (msg.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  return JSON.parse(text);
}

/* ---------- parsing & matching ---------- */

const STOP = new Set(('basic stage stage1 stage2 evolves from pokemon pokémon put this card on the trainer item supporter energy tool stadium ' +
  'with and your opponent hp ability attack weakness resistance retreat illus rule when knocked out prize cards special').split(' '));
const SUFFIX = new Set(['ex', 'gx', 'v', 'vmax', 'vstar', 'break', 'lv', 'prime', 'star', 'tag', 'team', 'radiant', 'mega', 'm']);

const normText = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

function lev(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}
const sim = (a, b) => 1 - lev(a, b) / Math.max(a.length, b.length);

/** Find a collector number such as 4/102, 025/198, TG05/TG30 or SWSH050. */
function parseNumber(text) {
  const t = String(text)
    .replace(/(?<=\d)[oO](?=\d|\b)/g, '0').replace(/(?<=\b|\/)[oO](?=\d)/g, '0')
    .replace(/[|\\⁄]/g, '/');
  const pre = t.match(/\b(TG|GG|SV|RC)\s?(\d{1,3})\s*\/\s*(?:TG|GG|SV|RC)?\s?(\d{1,3})\b/i);
  if (pre) return { prefix: pre[1].toUpperCase(), n: parseInt(pre[2], 10), total: parseInt(pre[3], 10) };
  const all = [...t.matchAll(/(?<![\d/])(\d{1,3})\s*\/\s*(\d{2,3})(?![\d/])/g)]
    .map((m) => ({ prefix: '', n: parseInt(m[1], 10), total: parseInt(m[2], 10) }))
    .filter((x) => x.n > 0 && x.total >= 10 && x.n <= x.total * 1.7);
  if (all.length) return all[all.length - 1]; // the collector number sits at the bottom, so prefer the last hit
  const promo = t.match(/\b(SWSH|SM|XY|BW|SVP|HGSS|DP)\s?-?(\d{1,3})\b/i);
  if (promo) return { prefix: promo[1].toUpperCase(), n: parseInt(promo[2], 10), total: null };
  return null;
}

function nameTokens(text) {
  const words = (String(text).match(/[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'’.\-]{2,}/g) || [])
    .map((w) => w.replace(/[.'’\-]+$/, ''))
    .filter((w) => w.length >= 3 && w.length <= 14 && !STOP.has(w.toLowerCase()) && !SUFFIX.has(w.toLowerCase()) && !/['’]/.test(w));
  const seen = new Set();
  const capital = (w) => (/^[A-ZÀ-Þ]/.test(w) ? 1 : 0);
  // Card names are capitalised; OCR noise and rules text usually are not.
  return words.filter((w) => { const k = w.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => capital(b) - capital(a) || b.length - a.length).slice(0, 3);
}

const normLocal = (s) => String(s).toUpperCase().replace(/\s/g, '').replace(/^([A-Z]*)0*(\d+)$/, '$1$2');

function nameScore(cardName, hay, exactNames) {
  const cn = normText(cardName);
  if (exactNames.some((n) => normText(n) === cn)) return 1.2;
  const core = cn.split(' ').filter((w) => w.length >= 3 && !SUFFIX.has(w));
  if (!core.length) return 0;
  const toks = hay.split(' ').filter((t) => t.length >= 3);
  let total = 0;
  for (const w of core) {
    let best = 0;
    for (const t of toks) {
      if (Math.abs(t.length - w.length) > 3) continue;
      best = Math.max(best, sim(w, t));
    }
    total += best >= 0.6 ? best : 0;
  }
  return total / core.length;
}

/**
 * Look up possible cards in TCGdex and rank them.
 * hints: { names: string[], exactNames: string[], num, text, setName }
 */
async function findCandidates(hints) {
  const { names = [], exactNames = [], num = null, text = '', setName = '' } = hints;
  const setsMap = await getSets();
  const queries = [];
  if (num) queries.push(getJSON(`${API}/cards?localId=${encodeURIComponent(num.prefix ? num.prefix + num.n : String(num.n))}`));
  for (const n of [...new Set([...exactNames, ...names])].slice(0, 4)) queries.push(getJSON(`${API}/cards?name=${encodeURIComponent(n)}`));
  if (!queries.length) return [];

  const pool = new Map();
  const addAll = (results) => {
    for (const r of results) {
      if (r.status === 'fulfilled' && Array.isArray(r.value)) for (const c of r.value) if (!isPocket(c)) pool.set(c.id, c);
    }
  };
  addAll(await Promise.allSettled(queries));
  // OCR often garbles a letter or two ("Mews", "Charmeleo"). If nothing came back by name, retry with a shorter stem.
  if (![...pool.values()].some((c) => nameScore(c.name, normText(names.join(' ')), []) > 0) && names.length) {
    const stems = [...new Set(names.map((w) => (w.length <= 5 ? w.slice(0, -1) : w.slice(0, 5))).filter((s) => s.length >= 3))];
    addAll(await Promise.allSettled(stems.slice(0, 3).map((s) => getJSON(`${API}/cards?name=${encodeURIComponent(s)}`))));
  }

  const hay = normText([text, ...names, ...exactNames].join(' '));
  const hayWords = new Set(hay.split(' '));
  const setNorm = normText(setName);
  const ranked = [];
  for (const c of pool.values()) {
    const set = setsMap.get(setIdOf(c.id));
    let score = 0;
    const numHit = num && normLocal(c.localId) === normLocal((num.prefix || '') + num.n);
    if (numHit) score += 4;
    if (numHit && num.total && set && (set.cardCount?.official === num.total || set.cardCount?.total === num.total)) score += 6;
    const ns = nameScore(c.name, hay, exactNames);
    score += 6 * ns;
    // Suffixes like VMAX / ex / GX separate otherwise identical names.
    if (ns > 0) for (const w of normText(c.name).split(' ')) if (SUFFIX.has(w) && w.length >= 2 && hayWords.has(w)) score += 1.5;
    if (setNorm && set && normText(set.name) === setNorm) score += 3;
    if (c.image) score += 0.2;
    ranked.push({ ...c, set, score });
  }
  ranked.sort((a, b) => b.score - a.score);
  return ranked.filter((c) => c.score >= 3).slice(0, 18);
}

function confidenceOf(cands) {
  if (!cands.length) return null;
  const [a, b] = cands;
  return a.score >= 9 && (!b || a.score - b.score >= 1.5) ? 'strong' : 'guess';
}

/* ---------- pricing ---------- */

const PRINTING_ORDER = ['normal', 'holofoil', 'reverse-holofoil', '1st-edition-holofoil', '1st-edition-normal', 'unlimited-holofoil', 'unlimited'];
const printingLabel = (k) => ({
  normal: 'Normal', holofoil: 'Holo', 'reverse-holofoil': 'Reverse Holo',
  '1st-edition-holofoil': '1st Ed. Holo', '1st-edition-normal': '1st Edition', 'unlimited-holofoil': 'Unlimited Holo', unlimited: 'Unlimited',
}[k] || k.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' '));

/** Printings this card actually exists in: TCGplayer's price keys, or the card's variant flags as a fallback. */
function printingsOf(card) {
  const tp = card.pricing?.tcgplayer;
  let keys = tp ? Object.keys(tp).filter((k) => tp[k] && typeof tp[k] === 'object') : [];
  if (!keys.length && card.variants) {
    const v = card.variants;
    if (v.normal) keys.push('normal');
    if (v.holo) keys.push('holofoil');
    if (v.reverse) keys.push('reverse-holofoil');
    if (v.firstEdition) keys.push('1st-edition-holofoil');
  }
  return keys.sort((a, b) => {
    const ia = PRINTING_ORDER.indexOf(a), ib = PRINTING_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
}

/** Both marketplace values for one printing. Cardmarket's "-holo" columns are its reverse-holo prices. */
function valuesFor(card, printing) {
  const tp = card.pricing?.tcgplayer;
  const cm = card.pricing?.cardmarket;
  const v = tp && printing ? tp[printing] : null;
  const rev = printing === 'reverse-holofoil';
  return {
    usd: v ? (v.marketPrice ?? v.midPrice ?? null) : null,
    eur: cm ? ((rev ? cm['trend-holo'] : cm.trend) ?? (rev ? cm['avg-holo'] : cm.avg) ?? null) : null,
  };
}

/* ---------- scan flow ---------- */

async function identify(canvas) {
  if (state.busy) return;
  state.busy = true;
  renderDock();
  els.guide.classList.add('captured');
  try {
    let hints = null;
    if (apiKey()) {
      setStatus('Reading card…', { busy: true });
      try {
        const r = await claudeIdentify(canvas);
        if (!r.is_pokemon_card) { setStatus("That doesn't look like a Pokémon card. Try again.", { error: true }); return; }
        hints = { exactNames: r.name ? [r.name] : [], names: nameTokens(r.name), num: parseNumber(r.number), text: r.name, setName: r.set_name };
      } catch (e) {
        setStatus(`${e.message} Using the on-device reader…`, { busy: true, error: true });
      }
    }
    if (!hints) {
      setStatus('Reading card…', { busy: true });
      const t = await ocrCard(canvas);
      hints = {
        names: nameTokens(t.top).concat(nameTokens(t.full).slice(0, 1)),
        num: parseNumber(t.bottom) || parseNumber(t.full),
        text: t.top + ' ' + t.full,
      };
    }
    setStatus('Finding match…', { busy: true });
    const cands = await findCandidates(hints);
    if (!cands.length) {
      const seen = [hints.exactNames?.[0] || hints.names?.[0], hints.num && `${hints.num.prefix}${hints.num.n}${hints.num.total ? '/' + hints.num.total : ''}`].filter(Boolean).join(', ');
      setStatus(`No match${seen ? ` for "${seen}"` : ''}. Move closer, cut the glare, or use Search.`, { error: true });
      return;
    }
    state.scans += 1; storageSet('pokescan.scans', state.scans);
    if (state.scans >= 2) setHelp(false);
    state.candidates = cands;
    state.confidence = confidenceOf(cands);
    setStatus('Getting prices…', { busy: true });
    await openCard(cands[0].id);
    idleStatus();
    if (state.confidence === 'guess') openChooser(true);
  } catch (e) {
    setStatus(e.message || 'Something went wrong. Try again.', { error: true });
  } finally {
    state.busy = false;
    els.guide.classList.remove('captured');
    renderDock();
  }
}

function onScan() {
  if (!state.stream) { startCamera(); return; }
  if (state.busy || !els.video.videoWidth) return;
  identify(grabFrame());
}

function scanFile(file) {
  if (!file) return;
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    stopCamera();
    els.video.hidden = true;
    els.stageEmpty.hidden = true;
    els.guide.hidden = true;
    els.still.src = url;
    els.still.hidden = false;
    const c = document.createElement('canvas');
    const k = Math.min(1, 2000 / Math.max(img.width, img.height));
    c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    identify(c);
  };
  img.onerror = () => setStatus("That file couldn't be opened as an image.", { error: true });
  img.src = url;
}

/** After a result is dismissed, go back to whatever the person was scanning with. */
function backToCamera() {
  closeSheet();
  if (!state.stream) {
    els.still.hidden = true;
    if (storageGet('pokescan.camOk', false)) startCamera();
    else { els.stageEmpty.hidden = false; renderDock(); }
  }
  idleStatus();
}

/* ---------- result sheet ---------- */

async function openCard(id, { demo = false } = {}) {
  const card = await getJSON(`${API}/cards/${encodeURIComponent(id)}`);
  state.card = card;
  const printings = printingsOf(card);
  // Only pre-select when there is exactly one printing; never carry the last card's choice over.
  state.printing = printings.length === 1 ? printings[0] : null;
  state.detailsOpen = false;
  if (demo) state.confidence = 'demo';
  renderSheet();
  els.sheet.classList.remove('closed');
  els.sheet.setAttribute('aria-hidden', 'false');
  renderDock();
}

function closeSheet() {
  els.sheet.classList.add('closed');
  els.sheet.setAttribute('aria-hidden', 'true');
  state.card = null;
  renderDock();
}

function numberText(c) {
  const total = c.set?.cardCount?.official;
  return total && /^\d+$/.test(c.localId) ? `${c.localId}/${String(total).padStart(String(c.localId).length, '0')}` : c.localId;
}

const inBinder = (id) => state.collection.some((e) => e.id === id);

function renderSheet() {
  const c = state.card;
  if (!c) return;
  const printings = printingsOf(c);
  const tp = c.pricing?.tcgplayer, cm = c.pricing?.cardmarket;
  const updated = tp?.updated || cm?.updated;
  const updatedText = updated ? new Date(updated).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : null;
  const src = source();

  const chips = [
    { strong: '<span class="chip good">Match</span>', guess: '<span class="chip warn">Best guess</span>', picked: '<span class="chip good">Your pick</span>', demo: '<span class="chip info">Demo</span>' }[state.confidence] || '',
    state.confidence !== 'demo' && !inBinder(c.id) ? '<span class="chip new">New find</span>' : '',
  ].join('');

  // Headline: the chosen printing's value, or the range across printings while the person still has to choose.
  let priceHtml;
  const primaryLabel = src === 'cm' ? 'Cardmarket trend · EUR' : 'TCGplayer market · USD';
  const altLabel = src === 'cm' ? 'TCGplayer market · USD' : 'Cardmarket trend · EUR';
  const pick = (vals) => (src === 'cm' ? [vals.eur, vals.usd, eur, usd] : [vals.usd, vals.eur, usd, eur]);
  if (state.printing || !printings.length) {
    const vals = valuesFor(c, state.printing);
    const [main, alt, fmtMain, fmtAlt] = pick(vals);
    priceHtml = `
      <span class="price-label">${esc(primaryLabel)}${state.printing ? ' · ' + esc(printingLabel(state.printing)) : ''}</span>
      ${main != null ? `<span class="price-main">${fmtMain(main)}</span>` : '<span class="price-main none">Price unavailable</span>'}
      ${alt != null ? `<span class="price-alt">${fmtAlt(alt)}<small>${esc(altLabel)}</small></span>` : ''}`;
  } else {
    const mains = printings.map((p) => pick(valuesFor(c, p))[0]).filter((x) => x != null);
    const fmtMain = src === 'cm' ? eur : usd;
    const lo = Math.min(...mains), hi = Math.max(...mains);
    priceHtml = `
      <span class="price-label">${esc(primaryLabel)} · depends on printing</span>
      ${mains.length ? `<span class="price-main range">${lo === hi ? fmtMain(lo) : `${fmtMain(lo)} – ${fmtMain(hi)}`}</span>` : '<span class="price-main none">Price unavailable</span>'}`;
  }

  const v = tp && state.printing ? tp[state.printing] : null;
  const rev = state.printing === 'reverse-holofoil';
  const productId = v?.productId || (tp && Object.values(tp).find((x) => x && x.productId)?.productId);
  const tcgLink = productId ? `https://www.tcgplayer.com/product/${productId}` : `https://www.tcgplayer.com/search/pokemon/product?q=${encodeURIComponent(c.name + ' ' + (c.set?.name || ''))}`;
  const ebayLink = `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(`${c.name} ${numberText(c)} ${c.set?.name || ''}`.trim())}&LH_Sold=1&LH_Complete=1`;
  const multiple = state.candidates.length > 1 && state.confidence !== 'demo';

  els.sheetBody.innerHTML = `
    <div class="ident">
      <button class="thumb" type="button" id="thumbBtn" aria-label="View the card larger">
        ${c.image ? `<img src="${esc(imgUrl(c.image, 'low'))}" alt="${esc(c.name)}">` : ''}
      </button>
      <div class="ident-meta">
        <div class="chips">${chips}</div>
        <h2 class="card-name">${esc(c.name)}</h2>
        <p class="card-sub">${esc(c.set?.name || 'Unknown set')} · <span class="mono">#${esc(numberText(c))}</span>${c.rarity ? ' · ' + esc(c.rarity) : ''}</p>
      </div>
    </div>

    ${printings.length > 1 ? `
    <div class="printings${state.printing ? '' : ' need'}" role="group" aria-label="Printing">
      <span class="label">${state.printing ? 'Printing' : 'Choose printing'}</span>
      ${printings.map((p) => `<button type="button" class="printing" data-p="${esc(p)}" aria-pressed="${p === state.printing}">${esc(printingLabel(p))}</button>`).join('')}
    </div>` : ''}

    <div class="price">
      ${priceHtml}
      <span class="price-note">Near-mint, ungraded${updatedText ? ` · Updated ${esc(updatedText)}` : ''}</span>
    </div>

    <button class="row-btn" type="button" id="detailsBtn" aria-expanded="${state.detailsOpen}" aria-controls="details">
      Price details
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>
    </button>
    <div class="details" id="details" ${state.detailsOpen ? '' : 'hidden'}>
      <div class="price-table">
        <h3><span>TCGplayer${state.printing ? ' · ' + esc(printingLabel(state.printing)) : ''}</span><span>USD</span></h3>
        ${v ? `<dl>
          <dt>Market</dt><dd>${usd(v.marketPrice)}</dd>
          <dt>Low</dt><dd>${usd(v.lowPrice)}</dd>
          <dt>Mid</dt><dd>${usd(v.midPrice)}</dd>
          <dt>High</dt><dd>${usd(v.highPrice)}</dd>
        </dl>` : `<p>${state.printing || !tp ? 'No TCGplayer listings.' : 'Choose a printing to see its prices.'}</p>`}
      </div>
      <div class="price-table">
        <h3><span>Cardmarket${rev ? ' · Reverse Holo' : ''}</span><span>EUR</span></h3>
        ${cm ? `<dl>
          <dt>Trend</dt><dd>${eur(rev ? cm['trend-holo'] : cm.trend)}</dd>
          <dt>Low</dt><dd>${eur(rev ? cm['low-holo'] : cm.low)}</dd>
          <dt>7-day avg</dt><dd>${eur(rev ? cm['avg7-holo'] : cm.avg7)}</dd>
          <dt>30-day avg</dt><dd>${eur(rev ? cm['avg30-holo'] : cm.avg30)}</dd>
        </dl>` : '<p>No Cardmarket sales.</p>'}
      </div>
      <div class="links">
        <a class="btn" href="${esc(tcgLink)}" target="_blank" rel="noopener">TCGplayer</a>
        <a class="btn" href="${esc(ebayLink)}" target="_blank" rel="noopener">eBay sold</a>
      </div>
    </div>

    ${multiple ? `<button class="row-btn" type="button" id="wrongBtn">Wrong card? Choose another
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg></button>` : ''}
  `;

  els.sheetBody.querySelectorAll('.printing').forEach((b) => b.addEventListener('click', () => { state.printing = b.dataset.p; renderSheet(); renderDock(); }));
  $('#detailsBtn').addEventListener('click', () => { state.detailsOpen = !state.detailsOpen; renderSheet(); });
  $('#wrongBtn')?.addEventListener('click', () => openChooser(false));
  $('#thumbBtn').addEventListener('click', () => {
    if (!c.image) return;
    els.lightboxImg.src = imgUrl(c.image, 'high');
    els.lightboxImg.alt = c.name;
    els.lightbox.hidden = false;
  });
}

/* ---------- dock ---------- */

function renderDock() {
  const showResult = !!state.card && !els.sheet.classList.contains('closed');
  els.helpBtn.hidden = !state.stream;
  els.dockReady.hidden = showResult;
  els.dockResult.hidden = !showResult;
  if (showResult) {
    const needPrinting = printingsOf(state.card).length > 1 && !state.printing;
    els.addBtn.disabled = state.saving || needPrinting || state.confidence === 'demo';
    els.addBtn.textContent = state.confidence === 'demo' ? 'Demo card' : needPrinting ? 'Choose printing' : 'Add & next';
    els.skipBtn.textContent = state.confidence === 'demo' ? 'Close' : 'Skip';
  } else {
    els.scanBtn.disabled = state.busy;
    els.scanBtn.innerHTML = state.busy ? '<span class="spin"></span> Scanning…'
      : state.stream ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2"/><circle cx="12" cy="12" r="3"/></svg> Scan'
      : 'Start camera';
  }
}

/* ---------- chooser & search ---------- */

function rowHtml(c, current) {
  return `<button type="button" class="list-row" data-id="${esc(c.id)}" aria-current="${current}">
    ${c.image ? `<img loading="lazy" src="${esc(imgUrl(c.image, 'low'))}" alt="">` : '<div class="ph"></div>'}
    <span class="t"><span class="n">${esc(c.name)}</span><span class="s">${esc(c.set?.name || setIdOf(c.id))} · #${esc(c.localId)}</span></span>
    <span></span>
  </button>`;
}

function openPanel(p) { p.hidden = false; }
function closePanel(p) { p.hidden = true; }

function openChooser(auto) {
  els.chooserNote.textContent = auto
    ? "The scan wasn't certain. Tap the card that matches yours."
    : 'Tap the card that matches yours.';
  els.chooserList.innerHTML = state.candidates.map((c) => rowHtml(c, state.card && c.id === state.card.id)).join('');
  openPanel(els.chooser);
}

els.chooserList.addEventListener('click', async (ev) => {
  const row = ev.target.closest('.list-row');
  if (!row) return;
  closePanel(els.chooser);
  state.confidence = 'picked';
  try { await openCard(row.dataset.id); } catch (e) { setStatus(e.message, { error: true }); }
});

async function runSearch(q) {
  q = q.trim();
  if (!q) return;
  els.searchNote.textContent = 'Searching…';
  els.searchList.innerHTML = '';
  try {
    const num = parseNumber(q) || (q.match(/\b\d{1,3}\b/) ? { prefix: '', n: parseInt(q.match(/\b(\d{1,3})\b/)[1], 10), total: null } : null);
    const namePart = q.replace(/[A-Z]{0,4}\d{1,3}\s*\/\s*[A-Z]{0,4}\d{1,3}/gi, ' ').replace(/\b\d{1,3}\b/g, ' ').replace(/#/g, ' ').trim();
    const cands = await findCandidates({ exactNames: namePart ? [namePart] : [], names: nameTokens(namePart), num, text: namePart });
    if (!cands.length) { els.searchNote.textContent = `No cards found for "${q}". Check the spelling, or try just the name.`; return; }
    state.candidates = cands;
    els.searchNote.textContent = `${cands.length} match${cands.length === 1 ? '' : 'es'}. Tap yours.`;
    els.searchList.innerHTML = cands.map((c) => rowHtml(c, false)).join('');
  } catch (e) {
    els.searchNote.textContent = e.message || 'Search failed. Try again.';
  }
}

els.searchList.addEventListener('click', async (ev) => {
  const row = ev.target.closest('.list-row');
  if (!row) return;
  closePanel(els.searchPanel);
  state.confidence = 'picked';
  try { await openCard(row.dataset.id); } catch (e) { setStatus(e.message, { error: true }); }
});

/* ---------- binder ---------- */

function entryKey(e) { return e.id + '|' + (e.printing || ''); }

function binderStats() {
  const col = state.collection;
  const count = col.reduce((s, e) => s + e.qty, 0);
  const totalUsd = col.reduce((s, e) => s + (e.usd ?? 0) * e.qty, 0);
  const totalEur = col.reduce((s, e) => s + (e.eur ?? 0) * e.qty, 0);
  const priced = col.reduce((s, e) => s + ((source() === 'cm' ? e.eur : e.usd) != null ? e.qty : 0), 0);
  return { count, totalUsd, totalEur, priced };
}

function renderStrip(addedText) {
  const { count, totalUsd, totalEur } = binderStats();
  const label = els.stripLabel;
  if (addedText) {
    label.textContent = addedText;
    label.classList.add('added');
  } else {
    label.textContent = count ? `Binder · ${count} card${count === 1 ? '' : 's'}` : 'Binder · empty';
    label.classList.remove('added');
  }
  els.stripTotal.textContent = count ? (source() === 'cm' ? eur(totalEur) : usd(totalUsd)) : '';
}

function flyToStrip() {
  if (reducedMotion()) return;
  const thumb = els.sheetBody.querySelector('.thumb img');
  if (!thumb) return;
  const a = thumb.getBoundingClientRect(), b = els.strip.getBoundingClientRect();
  const fly = thumb.cloneNode();
  fly.className = 'flyer';
  Object.assign(fly.style, { left: a.left + 'px', top: a.top + 'px', width: a.width + 'px', height: a.height + 'px' });
  document.body.appendChild(fly);
  const dx = b.left + 30 - (a.left + a.width / 2), dy = b.top + b.height / 2 - (a.top + a.height / 2);
  fly.animate(
    [{ transform: 'translate(0,0) scale(1)', opacity: 1 }, { transform: `translate(${dx}px, ${dy}px) scale(.28)`, opacity: 0.5 }],
    { duration: 190, easing: 'cubic-bezier(.3,.7,.4,1)' },
  ).finished.finally(() => fly.remove());
}

function addAndNext() {
  const c = state.card;
  if (!c || state.saving || state.confidence === 'demo') return;
  const printings = printingsOf(c);
  if (printings.length > 1 && !state.printing) return;
  state.saving = true;
  renderDock();

  const isNew = !inBinder(c.id);
  const vals = valuesFor(c, state.printing);
  const key = c.id + '|' + (state.printing || '');
  let entry = state.collection.find((e) => entryKey(e) === key);
  const created = !entry;
  if (entry) {
    entry.qty += 1;
    entry.usd = vals.usd; entry.eur = vals.eur;
  } else {
    entry = { id: c.id, name: c.name, set: c.set?.name || '', localId: c.localId, number: numberText(c), image: c.image || '',
      printing: state.printing, usd: vals.usd, eur: vals.eur, qty: 1, added: Date.now() };
    state.collection.unshift(entry);
  }
  saveCollection();
  state.lastAdd = { key, created };

  flyToStrip();
  haptic();
  chime();
  renderStrip(`${isNew ? 'New find · ' : ''}Added · ${c.name} ×${entry.qty}`);
  els.strip.classList.remove('glint', 'pop'); void els.strip.offsetWidth;
  els.strip.classList.add(isNew && !reducedMotion() ? 'glint' : 'pop');
  els.undoBtn.hidden = false;
  clearTimeout(state.undoTimer);
  state.undoTimer = setTimeout(endUndo, 7000);

  state.saving = false;
  backToCamera();
}

function endUndo() {
  els.undoBtn.hidden = true;
  state.lastAdd = null;
  renderStrip();
}

function undoAdd() {
  const la = state.lastAdd;
  if (!la) return;
  const i = state.collection.findIndex((e) => entryKey(e) === la.key);
  if (i >= 0) {
    if (la.created || state.collection[i].qty <= 1) state.collection.splice(i, 1);
    else state.collection[i].qty -= 1;
    saveCollection();
  }
  clearTimeout(state.undoTimer);
  els.undoBtn.hidden = true;
  state.lastAdd = null;
  renderStrip('Removed the last card');
  setTimeout(() => { if (!state.lastAdd) renderStrip(); }, 1800);
  if (!els.binderPanel.hidden) renderBinder();
}

function renderBinder() {
  const col = state.collection;
  const { count, totalUsd, totalEur, priced } = binderStats();
  const cm = source() === 'cm';
  if (!col.length) {
    els.binderBody.innerHTML = '<p class="empty-note">No cards yet. Scan a card and tap <b>Add &amp; next</b> to start your binder.</p>';
    return;
  }
  els.binderBody.innerHTML = `
    <div class="binder-sum">
      <span class="price-label">${cm ? 'Cardmarket trend · EUR' : 'TCGplayer market · USD'}</span>
      <span class="big">${cm ? eur(totalEur) : usd(totalUsd)}</span>
      <span class="eur">${cm ? usd(totalUsd) : eur(totalEur)} <small class="price-label">${cm ? 'TCGplayer market · USD' : 'Cardmarket trend · EUR'}</small></span>
      <span class="meta">${count} card${count === 1 ? '' : 's'} · ${priced} of ${count} priced</span>
    </div>
    <div class="list">
      ${col.map((e, i) => `
        <div class="list-row binder-row">
          ${e.image ? `<img loading="lazy" src="${esc(imgUrl(e.image, 'low'))}" alt="">` : '<div class="ph"></div>'}
          <span class="t">
            <span class="n">${esc(e.name)}</span>
            <span class="s">${e.printing ? esc(printingLabel(e.printing)) + ' · ' : ''}${esc(e.set)} #${esc(e.number || e.localId)}</span>
            <span class="qty">
              <button type="button" data-act="dec" data-i="${i}" aria-label="${e.qty > 1 ? 'One fewer' : 'Remove'} ${esc(e.name)}">${e.qty > 1 ? '−' : '×'}</button>
              <span>${e.qty}</span>
              <button type="button" data-act="inc" data-i="${i}" aria-label="One more ${esc(e.name)}">+</button>
            </span>
          </span>
          <span class="v">
            <span class="usd mono">${cm ? (e.eur != null ? eur(e.eur * e.qty) : 'No price') : (e.usd != null ? usd(e.usd * e.qty) : 'No price')}</span>
            <span class="eur mono">${cm ? (e.usd != null ? usd(e.usd * e.qty) : '') : (e.eur != null ? eur(e.eur * e.qty) : '')}</span>
          </span>
        </div>`).join('')}
    </div>
    <div class="binder-tools">
      <button class="btn" type="button" data-act="refresh">Refresh prices</button>
      <button class="btn" type="button" data-act="csv">Export CSV</button>
      <button class="btn" type="button" data-act="clear">Clear binder</button>
    </div>
    <div class="binder-tools" id="confirmClear" hidden>
      <span class="confirm">Remove all ${count} cards from the binder?</span>
      <button class="btn primary" type="button" data-act="clear-yes">Yes, clear</button>
      <button class="btn" type="button" data-act="clear-no">Keep them</button>
    </div>`;
}

els.binderBody.addEventListener('click', (ev) => {
  const b = ev.target.closest('button[data-act]');
  if (!b) return;
  const act = b.dataset.act;
  const e = state.collection[+b.dataset.i];
  if (act === 'inc' && e) e.qty += 1;
  else if (act === 'dec' && e) { if (e.qty > 1) e.qty -= 1; else state.collection.splice(+b.dataset.i, 1); }
  else if (act === 'refresh') return refreshPrices(b);
  else if (act === 'csv') return exportCsv();
  else if (act === 'clear') { $('#confirmClear').hidden = false; return; }
  else if (act === 'clear-no') { $('#confirmClear').hidden = true; return; }
  else if (act === 'clear-yes') state.collection = [];
  saveCollection();
  renderBinder();
  renderStrip();
});

async function refreshPrices(btn) {
  btn.disabled = true;
  let failed = 0;
  for (let i = 0; i < state.collection.length; i++) {
    const e = state.collection[i];
    btn.textContent = `Refreshing ${i + 1}/${state.collection.length}…`;
    try {
      const card = await getJSON(`${API}/cards/${encodeURIComponent(e.id)}`);
      const vals = valuesFor(card, e.printing || printingsOf(card)[0]);
      e.usd = vals.usd; e.eur = vals.eur;
    } catch { failed++; }
  }
  saveCollection();
  renderBinder();
  renderStrip(failed ? `${failed} card${failed === 1 ? '' : 's'} couldn't refresh` : 'Prices refreshed');
  setTimeout(() => renderStrip(), 2200);
}

function exportCsv() {
  const rows = [['Name', 'Set', 'Number', 'Printing', 'Qty', 'TCGplayer market (USD)', 'Cardmarket trend (EUR)', 'Total USD', 'Total EUR', 'TCGdex ID']];
  for (const e of state.collection) {
    rows.push([e.name, e.set, e.number || e.localId, e.printing ? printingLabel(e.printing) : '', e.qty, e.usd ?? '', e.eur ?? '',
      e.usd != null ? (e.usd * e.qty).toFixed(2) : '', e.eur != null ? (e.eur * e.qty).toFixed(2) : '', e.id]);
  }
  const csv = rows.map((r) => r.map((x) => `"${String(x).replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = `pokemon-binder-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/* ---------- settings ---------- */

els.settingsBtn.addEventListener('click', () => {
  els.apiKey.value = apiKey();
  els.soundOpt.checked = soundOn();
  els.settings.querySelectorAll('input[name=source]').forEach((r) => { r.checked = r.value === source(); });
  els.settings.showModal();
});
els.settings.addEventListener('close', () => {
  if (els.settings.returnValue !== 'save') return;
  storageSet('pokescan.apiKey', els.apiKey.value.trim());
  storageSet('pokescan.sound', els.soundOpt.checked);
  const s = els.settings.querySelector('input[name=source]:checked');
  if (s) storageSet('pokescan.source', s.value);
  renderStrip();
  if (state.card) renderSheet();
  if (!els.binderPanel.hidden) renderBinder();
});

/* ---------- wiring ---------- */

els.scanBtn.addEventListener('click', onScan);
els.searchBtn.addEventListener('click', () => { openPanel(els.searchPanel); setTimeout(() => els.searchInput.focus(), 50); });
els.searchForm.addEventListener('submit', (e) => { e.preventDefault(); els.searchInput.blur(); runSearch(els.searchInput.value); });
els.fileInput.addEventListener('change', () => { scanFile(els.fileInput.files[0]); els.fileInput.value = ''; });
els.skipBtn.addEventListener('click', backToCamera);
els.addBtn.addEventListener('click', addAndNext);
els.undoBtn.addEventListener('click', undoAdd);
els.stripMain.addEventListener('click', () => { renderBinder(); openPanel(els.binderPanel); });
els.helpBtn.addEventListener('click', () => setHelp(!els.guide.classList.contains('help')));
els.lightbox.addEventListener('click', () => { els.lightbox.hidden = true; });
els.demoBtn.addEventListener('click', async () => {
  state.candidates = [];
  try { await openCard('base1-4', { demo: true }); } catch (e) { setStatus(e.message, { error: true }); }
});
document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => closePanel($('#' + b.dataset.close))));

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!els.lightbox.hidden) { els.lightbox.hidden = true; return; }
    const open = [els.chooser, els.searchPanel, els.binderPanel].find((p) => !p.hidden);
    if (open) { closePanel(open); return; }
    if (state.card) backToCamera();
    return;
  }
  if (e.code === 'Space' && !e.target.closest('input, textarea, select, button, a, dialog') && !state.card) {
    e.preventDefault();
    onScan();
  }
});

// Drop a photo anywhere on the camera.
els.stage.addEventListener('dragover', (e) => e.preventDefault());
els.stage.addEventListener('drop', (e) => { e.preventDefault(); scanFile(e.dataTransfer.files[0]); });

renderStrip();
renderDock();
setStatus('');
getSets().catch(() => {});
// Open straight into the camera if the person already allowed it here before.
(async () => {
  let granted = false;
  try { granted = (await navigator.permissions?.query({ name: 'camera' }))?.state === 'granted'; } catch { /* unsupported */ }
  if (granted || storageGet('pokescan.camOk', false)) startCamera();
})();
