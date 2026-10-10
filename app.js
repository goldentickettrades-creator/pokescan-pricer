'use strict';

const API = 'https://api.tcgdex.net/v2/en';
const CLAUDE_MODEL = 'claude-opus-5-5';
const $ = (s) => document.querySelector(s);

const els = {
  video: $('#video'), still: $('#still'), guide: $('#guide'), viewfinder: $('#viewfinder'), vfEmpty: $('#vfEmpty'),
  startCam: $('#startCam'), scanBtn: $('#scanBtn'), fileInput: $('#fileInput'), camSelect: $('#camSelect'),
  statusLine: $('#statusLine'), bar: $('#bar'), barFill: $('#barFill'),
  searchForm: $('#searchForm'), searchInput: $('#searchInput'),
  emptySlip: $('#emptySlip'), slipWrap: $('#slipWrap'), alts: $('#alts'),
  binder: $('#binder'), binderBody: $('#binderBody'), ledgerEmpty: $('#ledgerEmpty'), ledgerTools: $('#ledgerTools'),
  ledgerTotal: $('#ledgerTotal'), ledgerCount: $('#ledgerCount'),
  refreshAll: $('#refreshAll'), exportCsv: $('#exportCsv'), clearAll: $('#clearAll'),
  confirmClear: $('#confirmClear'), confirmClearYes: $('#confirmClearYes'), confirmClearNo: $('#confirmClearNo'),
  settings: $('#settings'), settingsBtn: $('#settingsBtn'), apiKey: $('#apiKey'), modePill: $('#modePill'), modeText: $('#modeText'),
};

const state = {
  stream: null,
  busy: false,
  card: null,          // full TCGdex card
  variant: null,       // selected tcgplayer variant key
  candidates: [],
  confidence: null,    // 'strong' | 'guess' | 'example' | 'picked'
  collection: loadCollection(),
};

/* ---------- small helpers ---------- */

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const usd = (n) => (n == null || isNaN(n) ? '—' : '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const eur = (n) => (n == null || isNaN(n) ? '—' : '€' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

function storageGet(k, fallback) {
  try { const v = localStorage.getItem(k); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
}
function storageSet(k, v) {
  try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ }
}
function loadCollection() { return storageGet('pokescan.collection', []); }
function saveCollection() { storageSet('pokescan.collection', state.collection); }
function apiKey() { return storageGet('pokescan.apiKey', ''); }

async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Card database returned ${r.status}`);
  return r.json();
}

function setStatus(msg, { error = false, busy = false, progress = null } = {}) {
  els.statusLine.className = 'status-line' + (error ? ' error' : '');
  els.statusLine.innerHTML = (busy ? '<span class="spin"></span>' : '') + `<span>${esc(msg)}</span>`;
  els.bar.hidden = progress == null;
  if (progress != null) els.barFill.style.width = Math.round(progress * 100) + '%';
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

/* ---------- camera ---------- */

async function startCamera(deviceId) {
  stopCamera();
  if (!navigator.mediaDevices?.getUserMedia) {
    setStatus('This browser cannot use the camera here. Use Upload photo instead.', { error: true });
    return;
  }
  const video = deviceId
    ? { deviceId: { exact: deviceId }, width: { ideal: 1920 }, height: { ideal: 1080 } }
    : { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } };
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
    els.video.srcObject = state.stream;
    await els.video.play();
    els.vfEmpty.hidden = true;
    els.still.hidden = true;
    els.video.hidden = false;
    els.guide.hidden = false;
    els.scanBtn.disabled = false;
    setStatus('Camera on. Fill the frame with the card, then press Scan card (or Space).');
    await listCameras();
  } catch (e) {
    const denied = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
    setStatus(denied
      ? 'Camera permission was blocked. Allow it in the address bar, or use Upload photo.'
      : 'No camera found. Use Upload photo, or type the card name below.', { error: true });
  }
}

function stopCamera() {
  if (state.stream) state.stream.getTracks().forEach((t) => t.stop());
  state.stream = null;
}

async function listCameras() {
  try {
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
    if (devices.length < 2) { els.camSelect.hidden = true; return; }
    const current = state.stream?.getVideoTracks()[0]?.getSettings().deviceId;
    els.camSelect.innerHTML = devices.map((d, i) =>
      `<option value="${esc(d.deviceId)}"${d.deviceId === current ? ' selected' : ''}>${esc(d.label || 'Camera ' + (i + 1))}</option>`).join('');
    els.camSelect.hidden = false;
  } catch { els.camSelect.hidden = true; }
}

/** Crop the area inside the on-screen card guide out of the live video frame. */
function grabFrame() {
  const v = els.video, vw = v.videoWidth, vh = v.videoHeight;
  const box = els.viewfinder.getBoundingClientRect();
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
let ocrProgressCb = null;
function getWorker() {
  if (!workerPromise) {
    workerPromise = Tesseract.createWorker('eng', 1, {
      logger: (m) => { if (m.status === 'recognizing text' && ocrProgressCb) ocrProgressCb(m.progress); },
    }).catch((e) => { workerPromise = null; throw e; });
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
  const passes = [
    ['top', band(canvas, 0, 0.14, 0, 0.78)],
    ['bottom', band(canvas, 0.84, 1, 0, 1)],
    ['full', band(canvas, 0, 1, 0, 1, 1200)],
  ];
  const out = {};
  for (let i = 0; i < passes.length; i++) {
    const [key, img] = passes[i];
    ocrProgressCb = (p) => setStatus('Reading the card…', { busy: true, progress: (i + p) / passes.length });
    const { data } = await worker.recognize(img);
    out[key] = data.text || '';
  }
  ocrProgressCb = null;
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
  const key = apiKey();
  const data = jpegB64(canvas);
  const schema = CARD_SCHEMA;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
      'anthropic-beta': 'server-side-fallback-2026-07-01',
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 4000,
      output_config: { effort: 'low', format: { type: 'json_schema', schema } },
      fallbacks: 'default',
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } },
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

/* ---------- scan flow ---------- */

async function identify(canvas) {
  if (state.busy) return;
  state.busy = true;
  els.scanBtn.disabled = true;
  try {
    let hints = null;
    if (apiKey()) {
      setStatus('Claude is reading the card…', { busy: true });
      try {
        const r = await claudeIdentify(canvas);
        if (!r.is_pokemon_card) { setStatus("That doesn't look like a Pokémon card. Try again with the card filling the frame.", { error: true }); return; }
        hints = { exactNames: r.name ? [r.name] : [], names: nameTokens(r.name), num: parseNumber(r.number), text: r.name, setName: r.set_name };
      } catch (e) {
        setStatus(`${e.message} Falling back to the on-device reader…`, { error: true });
      }
    }
    if (!hints) {
      setStatus('Reading the card…', { busy: true, progress: 0 });
      const t = await ocrCard(canvas);
      hints = {
        names: nameTokens(t.top).concat(nameTokens(t.full).slice(0, 1)),
        num: parseNumber(t.bottom) || parseNumber(t.full),
        text: t.top + ' ' + t.full,
      };
    }
    setStatus('Looking up the card…', { busy: true });
    const cands = await findCandidates(hints);
    if (!cands.length) {
      const seen = [hints.exactNames?.[0] || hints.names?.[0], hints.num && `${hints.num.prefix}${hints.num.n}${hints.num.total ? '/' + hints.num.total : ''}`].filter(Boolean).join(', ');
      setStatus(`Couldn't match that card${seen ? ` (read: ${seen})` : ''}. Hold it closer with less glare, or type the name and number below.`, { error: true });
      return;
    }
    state.candidates = cands;
    state.confidence = confidenceOf(cands);
    await showCard(cands[0].id);
    setStatus(state.confidence === 'strong' ? 'Matched. Scan the next card whenever you are ready.' : 'Best guess shown. If it is wrong, pick the right one under Other matches.');
  } catch (e) {
    setStatus(e.message || 'Something went wrong while scanning. Try again.', { error: true });
  } finally {
    state.busy = false;
    els.scanBtn.disabled = !state.stream;
  }
}

function scanFromCamera() {
  if (!state.stream || state.busy || !els.video.videoWidth) return;
  els.guide.classList.remove('flash'); void els.guide.offsetWidth; els.guide.classList.add('flash');
  identify(grabFrame());
}

function scanFromFile(file) {
  if (!file) return;
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    stopCamera();
    els.video.hidden = true;
    els.vfEmpty.hidden = true;
    els.guide.hidden = true;
    els.still.src = url;
    els.still.hidden = false;
    els.scanBtn.disabled = true;
    const c = document.createElement('canvas');
    const k = Math.min(1, 2000 / Math.max(img.width, img.height));
    c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    identify(c).finally(() => {
      els.vfEmpty.hidden = false;
      els.vfEmpty.querySelector('p').textContent = 'Photo checked. Start the camera to scan live, or upload another photo.';
    });
  };
  img.onerror = () => setStatus("That file couldn't be opened as an image.", { error: true });
  img.src = url;
}

async function manualSearch(q) {
  q = q.trim();
  if (!q || state.busy) return;
  state.busy = true;
  setStatus('Searching…', { busy: true });
  try {
    const num = parseNumber(q) || (q.match(/\b\d{1,3}\b/) ? { prefix: '', n: parseInt(q.match(/\b(\d{1,3})\b/)[1], 10), total: null } : null);
    const namePart = q.replace(/[A-Z]{0,4}\d{1,3}\s*\/\s*[A-Z]{0,4}\d{1,3}/gi, ' ').replace(/\b\d{1,3}\b/g, ' ').replace(/#/g, ' ').trim();
    const hints = { exactNames: namePart ? [namePart] : [], names: nameTokens(namePart), num, text: namePart };
    const cands = await findCandidates(hints);
    if (!cands.length) { setStatus(`No cards found for "${q}". Check the spelling, or try just the name.`, { error: true }); return; }
    state.candidates = cands;
    state.confidence = confidenceOf(cands);
    await showCard(cands[0].id);
    setStatus(`${cands.length} match${cands.length === 1 ? '' : 'es'} for "${q}".`);
  } catch (e) {
    setStatus(e.message || 'Search failed. Try again.', { error: true });
  } finally {
    state.busy = false;
  }
}

/* ---------- pricing ---------- */

const VARIANT_ORDER = ['normal', 'holofoil', 'reverse-holofoil', '1st-edition-holofoil', '1st-edition-normal', 'unlimited-holofoil', 'unlimited'];
const variantLabel = (k) => k.split('-').map((w) => (w === '1st' ? '1st' : w[0].toUpperCase() + w.slice(1))).join(' ').replace('Holofoil', 'Holo');

function tcgVariants(card) {
  const tp = card.pricing?.tcgplayer;
  if (!tp) return [];
  const keys = Object.keys(tp).filter((k) => tp[k] && typeof tp[k] === 'object');
  return keys.sort((a, b) => {
    const ia = VARIANT_ORDER.indexOf(a), ib = VARIANT_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
}

/** Headline value in USD for a card + variant (falls back to Cardmarket trend converted at a rough rate). */
function marketValue(card, variant) {
  const tp = card.pricing?.tcgplayer;
  const v = tp && variant && tp[variant];
  if (v && (v.marketPrice ?? v.midPrice) != null) return { usd: v.marketPrice ?? v.midPrice, source: 'TCGplayer market' };
  const cm = card.pricing?.cardmarket;
  if (cm) {
    const holo = variant && /holo/.test(variant);
    const trend = (holo ? cm['trend-holo'] : null) ?? cm.trend ?? cm.avg;
    if (trend != null) return { eur: trend, source: 'Cardmarket trend' };
  }
  return null;
}

/* ---------- rendering ---------- */

async function showCard(id) {
  const card = await getJSON(`${API}/cards/${encodeURIComponent(id)}`);
  state.card = card;
  const vars = tcgVariants(card);
  state.variant = vars[0] || null;
  renderSlip();
  renderAlts();
}

function renderSlip() {
  const c = state.card;
  if (!c) return;
  const vars = tcgVariants(c);
  const tp = c.pricing?.tcgplayer;
  const cm = c.pricing?.cardmarket;
  const v = tp && state.variant ? tp[state.variant] : null;
  const mv = marketValue(c, state.variant);
  const total = c.set?.cardCount?.official;
  const numberText = total && /^\d+$/.test(c.localId) ? `${c.localId}/${String(total).padStart(String(c.localId).length, '0')}` : c.localId;
  const updated = tp?.updated || cm?.updated;
  const updatedText = updated ? new Date(updated).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : null;
  const holo = state.variant && /holo/.test(state.variant);

  const conf = {
    strong: '<span class="chip good">● Strong match</span>',
    guess: '<span class="chip warn">● Best guess, check below</span>',
    example: '<span class="chip info">Example card</span>',
    picked: '<span class="chip good">● Your pick</span>',
  }[state.confidence] || '';

  const productId = v?.productId || (tp && Object.values(tp).find((x) => x && x.productId)?.productId);
  const tcgLink = productId ? `https://www.tcgplayer.com/product/${productId}` : `https://www.tcgplayer.com/search/pokemon/product?q=${encodeURIComponent(c.name + ' ' + (c.set?.name || ''))}`;
  const ebayQ = `${c.name} ${numberText} ${c.set?.name || ''}`.trim();
  const ebayLink = `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(ebayQ)}&LH_Sold=1&LH_Complete=1`;

  els.emptySlip.hidden = true;
  els.slipWrap.hidden = false;
  els.slipWrap.innerHTML = `
    <div class="slip">
      ${c.image ? `<img class="card-img" src="${esc(imgUrl(c.image))}" alt="${esc(c.name)} card" onerror="this.onerror=null;this.src='${esc(imgUrl(c.image, 'low').replace('.webp', '.png'))}'">` : '<div class="card-img" role="img" aria-label="No image available"></div>'}
      <div class="slip-meta">
        ${conf}
        <h2 class="card-title">${esc(c.name)}</h2>
        <p class="card-sub"><span>${esc(c.set?.name || 'Unknown set')}</span><span class="num">#${esc(numberText)}</span>${c.rarity ? `<span>${esc(c.rarity)}</span>` : ''}</p>
        <div class="value-block">
          <span class="value-label">${esc(mv?.source || 'Market value')}${state.variant && mv?.usd != null ? ' · ' + esc(variantLabel(state.variant)) : ''}</span>
          <span class="value-big">${mv ? (mv.usd != null ? usd(mv.usd) : eur(mv.eur)) : 'No price yet'}</span>
          <span class="value-note">${mv ? `Near-mint, ungraded${updatedText ? ` · updated ${esc(updatedText)}` : ''}` : 'No recent sales data for this printing.'}</span>
        </div>
        ${vars.length > 1 ? `<div class="variants" role="group" aria-label="Printing">${vars.map((k) =>
          `<button type="button" class="variant-btn" data-variant="${esc(k)}" aria-pressed="${k === state.variant}">${esc(variantLabel(k))} · ${usd(tp[k].marketPrice ?? tp[k].midPrice)}</button>`).join('')}</div>` : ''}
        <div class="price-grid">
          <div class="price-table">
            <h3><span>TCGplayer</span><span>USD</span></h3>
            ${v ? `<dl>
              <dt>Market</dt><dd>${usd(v.marketPrice)}</dd>
              <dt>Low</dt><dd>${usd(v.lowPrice)}</dd>
              <dt>Mid</dt><dd>${usd(v.midPrice)}</dd>
              <dt>High</dt><dd>${usd(v.highPrice)}</dd>
            </dl>` : '<p class="none">No TCGplayer listings.</p>'}
          </div>
          <div class="price-table">
            <h3><span>Cardmarket${holo ? ' · holo' : ''}</span><span>EUR</span></h3>
            ${cm ? `<dl>
              <dt>Trend</dt><dd>${eur(holo ? cm['trend-holo'] ?? cm.trend : cm.trend)}</dd>
              <dt>Low</dt><dd>${eur(holo ? cm['low-holo'] ?? cm.low : cm.low)}</dd>
              <dt>7-day avg</dt><dd>${eur(holo ? cm['avg7-holo'] ?? cm.avg7 : cm.avg7)}</dd>
              <dt>30-day avg</dt><dd>${eur(holo ? cm['avg30-holo'] ?? cm.avg30 : cm.avg30)}</dd>
            </dl>` : '<p class="none">No Cardmarket sales.</p>'}
          </div>
        </div>
        <div class="actions">
          <button class="btn primary" type="button" id="addBtn">Add to binder</button>
          <a class="btn" href="${esc(tcgLink)}" target="_blank" rel="noopener">TCGplayer</a>
          <a class="btn" href="${esc(ebayLink)}" target="_blank" rel="noopener">eBay sold</a>
        </div>
      </div>
    </div>`;

  els.slipWrap.querySelectorAll('.variant-btn').forEach((b) => b.addEventListener('click', () => { state.variant = b.dataset.variant; renderSlip(); }));
  $('#addBtn').addEventListener('click', addCurrentToBinder);
}

function renderAlts() {
  const others = state.candidates;
  if (!others || others.length < 2) { els.alts.hidden = true; els.alts.innerHTML = ''; return; }
  els.alts.hidden = false;
  els.alts.innerHTML = `
    <h3>Other matches</h3>
    <p class="hint">Not the right printing? Tap the one that matches your card.</p>
    <div class="alt-grid">${others.map((c) => `
      <button type="button" class="alt" data-id="${esc(c.id)}" aria-current="${state.card && c.id === state.card.id}">
        ${c.image ? `<img loading="lazy" src="${esc(imgUrl(c.image, 'low'))}" alt="">` : '<div class="ph"></div>'}
        <span>${esc(c.name)}</span>
        <span class="s">${esc(c.set?.name || setIdOf(c.id))} · ${esc(c.localId)}</span>
      </button>`).join('')}</div>`;
  els.alts.querySelectorAll('.alt').forEach((b) => b.addEventListener('click', async () => {
    setStatus('Loading card…', { busy: true });
    try {
      state.confidence = 'picked';
      await showCard(b.dataset.id);
      setStatus('Card updated.');
    } catch (e) { setStatus(e.message, { error: true }); }
  }));
}

/* ---------- binder (collection) ---------- */

function entryValueUsd(e) {
  if (e.usd != null) return e.usd;
  if (e.eur != null) return e.eur * 1.08; // rough EUR→USD so the total stays in one currency
  return 0;
}

function addCurrentToBinder() {
  const c = state.card;
  if (!c) return;
  const mv = marketValue(c, state.variant);
  const existing = state.collection.find((e) => e.id === c.id && e.variant === state.variant);
  if (existing) {
    existing.qty += 1;
  } else {
    state.collection.unshift({
      id: c.id, name: c.name, set: c.set?.name || '', localId: c.localId, image: c.image || '',
      variant: state.variant, usd: mv?.usd ?? null, eur: mv?.eur ?? null, qty: 1, added: Date.now(),
    });
  }
  saveCollection();
  renderBinder();
  setStatus(`Added ${c.name} to your binder.`);
}

function renderBinder() {
  const col = state.collection;
  const count = col.reduce((s, e) => s + e.qty, 0);
  const total = col.reduce((s, e) => s + entryValueUsd(e) * e.qty, 0);
  els.ledgerTotal.textContent = usd(total);
  els.ledgerCount.textContent = `${count} card${count === 1 ? '' : 's'}`;
  els.binder.hidden = !col.length;
  els.ledgerTools.hidden = !col.length;
  els.ledgerEmpty.hidden = !!col.length;
  els.binderBody.innerHTML = col.map((e, i) => `
    <tr>
      <td>${e.image ? `<img src="${esc(imgUrl(e.image, 'low'))}" alt="">` : ''}</td>
      <td><div class="nm">${esc(e.name)}</div><div class="st">${esc(e.set)} · #${esc(e.localId)}</div></td>
      <td>${e.variant ? esc(variantLabel(e.variant)) : '—'}</td>
      <td><span class="qty"><button type="button" data-act="dec" data-i="${i}" aria-label="One fewer">−</button>${e.qty}<button type="button" data-act="inc" data-i="${i}" aria-label="One more">+</button></span></td>
      <td class="money">${e.usd != null ? usd(e.usd) : e.eur != null ? eur(e.eur) : '—'}</td>
      <td class="money">${usd(entryValueUsd(e) * e.qty)}</td>
      <td><button class="btn small ghost" type="button" data-act="del" data-i="${i}">Remove</button></td>
    </tr>`).join('');
}

els.binderBody.addEventListener('click', (ev) => {
  const b = ev.target.closest('button[data-act]');
  if (!b) return;
  const i = +b.dataset.i, e = state.collection[i];
  if (!e) return;
  if (b.dataset.act === 'inc') e.qty += 1;
  if (b.dataset.act === 'dec') e.qty = Math.max(1, e.qty - 1);
  if (b.dataset.act === 'del') state.collection.splice(i, 1);
  saveCollection();
  renderBinder();
});

async function refreshAllPrices() {
  if (!state.collection.length) return;
  els.refreshAll.disabled = true;
  let done = 0, failed = 0;
  for (const e of state.collection) {
    setStatus(`Refreshing prices… ${done + 1} of ${state.collection.length}`, { busy: true, progress: done / state.collection.length });
    try {
      const card = await getJSON(`${API}/cards/${encodeURIComponent(e.id)}`);
      const mv = marketValue(card, e.variant || tcgVariants(card)[0]);
      e.usd = mv?.usd ?? null; e.eur = mv?.eur ?? null;
    } catch { failed++; }
    done++;
  }
  saveCollection();
  renderBinder();
  els.refreshAll.disabled = false;
  setStatus(failed ? `Prices refreshed, but ${failed} card${failed === 1 ? '' : 's'} could not be reached.` : 'All prices refreshed.', { error: !!failed });
}

function exportCsv() {
  const rows = [['Name', 'Set', 'Number', 'Variant', 'Qty', 'Each (USD)', 'Each (EUR)', 'Total (USD)', 'TCGdex ID']];
  for (const e of state.collection) {
    rows.push([e.name, e.set, e.localId, e.variant ? variantLabel(e.variant) : '', e.qty, e.usd ?? '', e.eur ?? '', (entryValueUsd(e) * e.qty).toFixed(2), e.id]);
  }
  const csv = rows.map((r) => r.map((x) => `"${String(x).replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = `pokemon-binder-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/* ---------- settings ---------- */

function renderMode() {
  const ai = !!apiKey();
  els.modePill.classList.toggle('ai', ai);
  els.modeText.textContent = ai ? 'Claude vision' : 'Text reader';
}

els.settingsBtn.addEventListener('click', () => { els.apiKey.value = apiKey(); els.settings.showModal(); });
els.settings.addEventListener('close', () => {
  const v = els.settings.returnValue;
  if (v === 'save') storageSet('pokescan.apiKey', els.apiKey.value.trim());
  if (v === 'clear') storageSet('pokescan.apiKey', '');
  renderMode();
});

/* ---------- wiring ---------- */

els.startCam.addEventListener('click', () => startCamera());
els.camSelect.addEventListener('change', () => startCamera(els.camSelect.value));
els.scanBtn.addEventListener('click', scanFromCamera);
els.fileInput.addEventListener('change', () => { scanFromFile(els.fileInput.files[0]); els.fileInput.value = ''; });
els.searchForm.addEventListener('submit', (e) => { e.preventDefault(); manualSearch(els.searchInput.value); });
els.refreshAll.addEventListener('click', refreshAllPrices);
els.exportCsv.addEventListener('click', exportCsv);
els.clearAll.addEventListener('click', () => { els.confirmClear.hidden = false; els.clearAll.hidden = true; });
els.confirmClearNo.addEventListener('click', () => { els.confirmClear.hidden = true; els.clearAll.hidden = false; });
els.confirmClearYes.addEventListener('click', () => {
  state.collection = []; saveCollection(); renderBinder();
  els.confirmClear.hidden = true; els.clearAll.hidden = false;
});

document.addEventListener('keydown', (e) => {
  if ((e.code === 'Space' || e.key === 'Enter') && !e.target.closest('input, textarea, select, button, a, dialog')) {
    e.preventDefault();
    scanFromCamera();
  }
});

// Drag a photo anywhere onto the scanner.
els.viewfinder.addEventListener('dragover', (e) => e.preventDefault());
els.viewfinder.addEventListener('drop', (e) => { e.preventDefault(); scanFromFile(e.dataTransfer.files[0]); });

renderMode();
renderBinder();
getSets().catch(() => {});
// Open on a real example so the price layout is visible before the first scan.
state.confidence = 'example';
showCard('base1-4').catch(() => {
  els.emptySlip.innerHTML = 'Scan a card to see its value here.';
});
