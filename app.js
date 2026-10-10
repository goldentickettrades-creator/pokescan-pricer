'use strict';

const API = 'https://api.tcgdex.net/v2/en';
const CLAUDE_MODEL = 'claude-opus-5-5';
const DEFAULT_OPENAI_MODEL = 'gpt-5-mini';
const $ = (s) => document.querySelector(s);

const els = {
  app: $('#app'), stage: $('#stage'), video: $('#video'), still: $('#still'), guide: $('#guide'),
  stageEmpty: $('#stageEmpty'), demoBtn: $('#demoBtn'), aiTip: $('#aiTip'), aiTipBtn: $('#aiTipBtn'),
  modes: $('#modes'), needsAi: $('#needsAi'), needsAiSetup: $('#needsAiSetup'), needsAiSearch: $('#needsAiSearch'),
  statusPill: $('#statusPill'), helpBtn: $('#helpBtn'),
  sheet: $('#sheet'), sheetBody: $('#sheetBody'),
  strip: $('#strip'), stripMain: $('#stripMain'), stripLabel: $('#stripLabel'), stripTotal: $('#stripTotal'), undoBtn: $('#undoBtn'),
  dockReady: $('#dockReady'), dockResult: $('#dockResult'), scanBtn: $('#scanBtn'), searchBtn: $('#searchBtn'),
  skipBtn: $('#skipBtn'), addBtn: $('#addBtn'), fileInput: $('#fileInput'),
  chooser: $('#chooser'), chooserList: $('#chooserList'), chooserNote: $('#chooserNote'),
  searchPanel: $('#searchPanel'), searchForm: $('#searchForm'), searchInput: $('#searchInput'), searchList: $('#searchList'), searchNote: $('#searchNote'),
  batchPanel: $('#batchPanel'), batchTitle: $('#batchTitle'), batchNote: $('#batchNote'), batchList: $('#batchList'), batchAdd: $('#batchAdd'), batchRescan: $('#batchRescan'),
  binderPanel: $('#binderPanel'), binderBody: $('#binderBody'),
  lightbox: $('#lightbox'), lightboxImg: $('#lightboxImg'),
  settings: $('#settings'), settingsBtn: $('#settingsBtn'), apiKey: $('#apiKey'), openaiKey: $('#openaiKey'), openaiModel: $('#openaiModel'),
  soundOpt: $('#soundOpt'), settingsErr: $('#settingsErr'),
};

const state = {
  stream: null,
  busy: false,
  saving: false,
  mode: storageGet('pokescan.mode', 'card'),   // 'card' | 'multi'
  card: null,            // full TCGdex card on the sheet
  sealed: null,          // sealed product on the sheet
  printing: null,        // chosen printing key, or null when the person still has to choose
  candidates: [],
  confidence: null,      // 'strong' | 'guess' | 'picked' | 'demo'
  detailsOpen: false,
  batch: [],
  searchKind: 'card',
  chooserPick: null,
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
const claudeKey = () => storageGet('pokescan.apiKey', '');
const openaiKey = () => storageGet('pokescan.openaiKey', '');
const openaiModel = () => storageGet('pokescan.openaiModel', '') || DEFAULT_OPENAI_MODEL;
const source = () => storageGet('pokescan.source', 'tcg'); // 'tcg' | 'cm'
const soundOn = () => storageGet('pokescan.sound', false);

/** Which vision AI to use, or null for the free on-device reader. */
function activeAI() {
  const p = storageGet('pokescan.provider', null);
  if (p === 'ocr') return null;
  if (p === 'openai') return openaiKey() ? 'openai' : null;
  if (p === 'claude') return claudeKey() ? 'claude' : null;
  return claudeKey() ? 'claude' : openaiKey() ? 'openai' : null;
}
const aiName = () => ({ claude: 'Claude', openai: 'ChatGPT' }[activeAI()] || '');

async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`The price database returned an error (${r.status}). Try again in a moment.`);
  return r.json();
}

function setStatus(msg, { busy = false, error = false } = {}) {
  els.statusPill.hidden = !msg;
  els.statusPill.classList.toggle('error', error);
  els.statusPill.innerHTML = (busy ? '<span class="spin"></span>' : '') + `<span>${esc(msg)}</span>`;
}
function idleStatus() {
  if (!state.stream) return setStatus('');
  setStatus(state.mode === 'multi' ? 'Fit everything in view, then tap Scan all.' : 'Fit the whole card inside the frame.');
}

const imgUrl = (base, q = 'high') => (base ? `${base}/${q}.webp` : '');
const sealedImg = (pid, big = false) => `https://tcgplayer-cdn.tcgplayer.com/product/${pid}_${big ? 'in_1000x1000' : '200w'}.jpg`;
const thumbOf = (e) => e.thumb || imgUrl(e.image, 'low');
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
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 3840 }, height: { ideal: 2160 } }, audio: false,
    });
    const track = state.stream.getVideoTracks()[0];
    // Keep refocusing as cards move in and out (supported on most Android phones; ignored elsewhere).
    try { await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }); } catch { /* unsupported */ }
    els.video.srcObject = state.stream;
    await els.video.play();
    els.stageEmpty.hidden = true;
    els.still.hidden = true;
    els.video.hidden = false;
    storageSet('pokescan.camOk', true);
    // Show the name/number zones for the first couple of scans, then keep the frame calm.
    setHelp(state.scans < 2);
    idleStatus();
  } catch (e) {
    const denied = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
    setStatus(denied ? 'Camera blocked. Allow it in your browser settings, or use Upload.' : 'No camera found. Use Upload or Search.', { error: true });
  }
  renderMode();
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
function grabGuide() {
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

/** The whole view at the best resolution available: a real photo where the browser allows it, else the video frame. */
async function grabFull() {
  const track = state.stream?.getVideoTracks()[0];
  if (track && 'ImageCapture' in window) {
    try {
      const blob = await new ImageCapture(track).takePhoto();
      const bmp = await createImageBitmap(blob);
      const c = document.createElement('canvas');
      c.width = bmp.width; c.height = bmp.height;
      c.getContext('2d').drawImage(bmp, 0, 0);
      return c;
    } catch { /* fall back to the video frame */ }
  }
  const v = els.video;
  const c = document.createElement('canvas');
  c.width = v.videoWidth; c.height = v.videoHeight;
  c.getContext('2d').drawImage(v, 0, 0);
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

/** Cut a region out of the card image, upscale it and boost contrast for OCR. */
function band(src, y0, y1, x0 = 0, x1 = 1, targetW = 1600) {
  const sw = src.width * (x1 - x0), sh = src.height * (y1 - y0);
  const k = targetW / sw;
  const c = document.createElement('canvas');
  c.width = Math.round(targetW); c.height = Math.max(1, Math.round(sh * k));
  const ctx = c.getContext('2d');
  ctx.filter = 'grayscale(1) contrast(1.8)';
  ctx.drawImage(src, src.width * x0, src.height * y0, sw, sh, 0, 0, c.width, c.height);
  return c;
}

async function ocrCard(canvas) {
  const worker = await getWorker();
  const out = {};
  // The collector number is tiny, so read each bottom corner on its own at roughly 3x zoom.
  for (const [key, img] of [
    ['top', band(canvas, 0, 0.14, 0, 0.78)],
    ['bottomLeft', band(canvas, 0.85, 1, 0, 0.55)],
    ['bottomRight', band(canvas, 0.85, 1, 0.45, 1)],
    ['full', band(canvas, 0, 1, 0, 1, 1200)],
  ]) {
    const { data } = await worker.recognize(img);
    out[key] = data.text || '';
  }
  out.bottom = out.bottomLeft + '\n' + out.bottomRight;
  return out;
}

/* ---------- vision AI: Claude or ChatGPT ---------- */

const ITEMS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['items'],
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'name', 'number', 'set_name', 'product_type'],
        properties: {
          kind: { type: 'string', enum: ['card', 'sealed'] },
          name: { type: 'string', description: 'Card name exactly as printed incl. suffixes (ex, V, VMAX, VSTAR, GX), or the full sealed product name' },
          number: { type: 'string', description: 'Card collector number as printed, e.g. 025/198, TG05/TG30, SWSH050; empty if unreadable or sealed' },
          set_name: { type: 'string', description: 'English set or expansion name, e.g. Obsidian Flames, Scarlet & Violet 151; empty if unknown' },
          product_type: { type: 'string', description: 'For sealed: Booster Box, Elite Trainer Box, Booster Bundle, Booster Pack, Tin, Collection, Blister, Build & Battle, etc. Empty for cards' },
        },
      },
    },
  },
};
const ITEMS_PROMPT = `Identify every English Pokémon Trading Card Game item in this photo: single cards and sealed products (booster boxes, Elite Trainer Boxes, booster bundles, packs, tins, collection boxes, blisters).
For each card, read the name and the collector number printed in a bottom corner, and name the set if you can tell from the set symbol or text.
For each sealed product, give its full product name as TCGplayer would list it (e.g. "Prismatic Evolutions Elite Trainer Box"), its set, and its product type.
List items left to right, top to bottom. Skip anything that is not Pokémon TCG. Return an empty list if there is none. Use an empty string for any field you cannot read.`;

/** JPEG base64 of an image, downscaled to keep requests small (card text stays legible). */
function jpegB64(canvas, maxSide) {
  let src = canvas;
  const big = Math.max(canvas.width, canvas.height);
  if (big > maxSide) {
    const k = maxSide / big;
    src = document.createElement('canvas');
    src.width = Math.round(canvas.width * k); src.height = Math.round(canvas.height * k);
    src.getContext('2d').drawImage(canvas, 0, 0, src.width, src.height);
  }
  return src.toDataURL('image/jpeg', 0.9).split(',')[1];
}

async function apiError(res, who) {
  let detail = '';
  try { detail = (await res.json()).error?.message || ''; } catch { /* ignore */ }
  if (res.status === 401) return new Error(`Your ${who} API key was rejected. Check it in Settings.`);
  if (res.status === 429) return new Error(`${who} says the key is out of credit or rate-limited.`);
  if (res.status === 404 && who === 'OpenAI') return new Error(`OpenAI doesn't recognize the model "${openaiModel()}". Change it in Settings.`);
  return new Error(`${who} request failed (${res.status}). ${detail}`.trim());
}

async function claudeItems(canvas, wide) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': claudeKey(),
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
      'anthropic-beta': 'server-side-fallback-2026-07-01',
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 6000,
      output_config: { effort: 'low', format: { type: 'json_schema', schema: ITEMS_SCHEMA } },
      fallbacks: 'default',
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: jpegB64(canvas, wide ? 2000 : 1400) } },
          { type: 'text', text: ITEMS_PROMPT },
        ],
      }],
    }),
  });
  if (!res.ok) throw await apiError(res, 'Anthropic');
  const msg = await res.json();
  if (msg.stop_reason === 'refusal') throw new Error('Claude declined to read this image.');
  const text = (msg.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  return JSON.parse(text).items || [];
}

async function openaiItems(canvas, wide) {
  const model = openaiModel();
  const body = {
    model,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: ITEMS_PROMPT },
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + jpegB64(canvas, wide ? 2000 : 1400), detail: 'high' } },
      ],
    }],
    response_format: { type: 'json_schema', json_schema: { name: 'pokemon_items', strict: true, schema: ITEMS_SCHEMA } },
  };
  if (/^(gpt-5|o\d)/i.test(model)) body.reasoning_effort = 'low';
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + openaiKey() },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await apiError(res, 'OpenAI');
  const msg = (await res.json()).choices?.[0]?.message;
  if (!msg) throw new Error('ChatGPT returned an empty answer.');
  if (msg.refusal) throw new Error('ChatGPT declined to read this image.');
  return JSON.parse(msg.content).items || [];
}

const aiItems = (canvas, wide) => (activeAI() === 'openai' ? openaiItems(canvas, wide) : claudeItems(canvas, wide));

/* ---------- card matching (TCGdex) ---------- */

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
    if (setNorm && set) {
      const sn = normText(set.name);
      if (sn === setNorm) score += 3;
      else if (sn.includes(setNorm) || setNorm.includes(sn)) score += 1.5;
    }
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

const hintsFromItem = (it) => ({
  exactNames: it.name ? [it.name] : [], names: nameTokens(it.name), num: parseNumber(it.number), text: it.name, setName: it.set_name,
});

/* ---------- sealed matching (daily TCGplayer snapshot in data/sealed.json) ---------- */

let sealedPromise = null;
function getSealed() {
  if (!sealedPromise) {
    sealedPromise = getJSON('data/sealed.json').then((d) => {
      const products = d.products.map(([pid, name, gid, market, low, mid, high]) => {
        const g = d.groups[gid] || ['', ''];
        return { pid, name, gid, group: g[0], released: g[1], market, low, mid, high, toks: sealedTokens(name + ' ' + g[0]), nameToks: sealedTokens(name) };
      });
      return { updated: d.updated, products };
    }).catch((e) => { sealedPromise = null; throw e; });
  }
  return sealedPromise;
}

const SEALED_SYNONYMS = [[/\betb\b/g, 'elite trainer box'], [/\bupc\b/g, 'ultra premium collection'], [/\bbb\b/g, 'booster box'], [/\bpc\b/g, 'pokemon center']];
const SEALED_STOP = new Set(['pokemon', 'tcg', 'the', 'and', 'of', 'a', 'sv', 'swsh', 'sm', 'xy', 'me']);
function sealedTokens(s) {
  let t = normText(s);
  for (const [re, rep] of SEALED_SYNONYMS) t = t.replace(re, rep);
  return t.split(' ').filter((w) => w && !SEALED_STOP.has(w));
}

/** Rank sealed products against a free-text name (plus optional set and product type). */
async function findSealed({ name = '', set = '', type = '' }) {
  const { products } = await getSealed();
  const q = sealedTokens(`${name} ${set} ${type}`);
  if (!q.length) return [];
  const qset = new Set(q);
  const ranked = [];
  for (const p of products) {
    let s = 0;
    for (const w of q) {
      let best = 0;
      for (const t of p.toks) {
        if (t === w) { best = 1; break; }
        if (w.length >= 4 && Math.abs(t.length - w.length) <= 2) best = Math.max(best, sim(w, t) >= 0.8 ? 0.8 : 0);
      }
      s += best;
    }
    s /= q.length;
    if (s < 0.5) continue;
    // Cases and displays are multiples of the product; only prefer them when asked for.
    for (const w of ['case', 'display']) if (p.toks.includes(w) && !qset.has(w)) s -= 0.25;
    s -= 0.015 * p.toks.filter((t) => !qset.has(t)).length;
    if (p.market == null) s -= 0.05;
    // Every word of the product's own name was asked for: as close to certain as a name match gets.
    const exact = p.nameToks.length > 0 && p.nameToks.every((t) => qset.has(t));
    if (exact) s += 0.05;
    ranked.push({ ...p, score: s, exact });
  }
  ranked.sort((a, b) => b.score - a.score);
  return ranked.slice(0, 15);
}

const sealedConfidence = (c) => (c.length && ((c[0].exact && !c[1]?.exact) || (c[0].score >= 0.85 && (!c[1] || c[0].score - c[1].score >= 0.08))) ? 'strong' : 'guess');

/* ---------- pricing (cards) ---------- */

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

async function identify(canvas, { wide = false } = {}) {
  if (state.busy) return;
  state.busy = true;
  renderDock();
  els.guide.classList.add('captured');
  try {
    const ai = activeAI();
    if (ai) {
      setStatus(wide ? `${aiName()} is looking at everything…` : 'Reading card…', { busy: true });
      let items;
      try {
        items = await aiItems(canvas, wide);
      } catch (e) {
        if (wide) throw e;
        setStatus(`${e.message} Using the on-device reader…`, { busy: true, error: true });
      }
      if (items) {
        if (!items.length) { setStatus(wide ? 'No Pokémon cards or sealed product found. Try more light or get closer.' : "That doesn't look like a Pokémon card. Try again.", { error: true }); return; }
        countScan();
        if (items.length === 1) return await showSingle(items[0]);
        return await showBatch(items);
      }
    }
    // Free on-device path: single cards only.
    setStatus('Reading card…', { busy: true });
    const t = await ocrCard(canvas);
    const hints = {
      names: nameTokens(t.top).concat(nameTokens(t.full).slice(0, 1)),
      num: parseNumber(t.bottom) || parseNumber(t.full),
      text: t.top + ' ' + t.full,
    };
    setStatus('Finding match…', { busy: true });
    const cands = await findCandidates(hints);
    if (!cands.length) {
      const seen = [hints.names?.[0], hints.num && `${hints.num.prefix}${hints.num.n}${hints.num.total ? '/' + hints.num.total : ''}`].filter(Boolean).join(', ');
      setStatus(`No match${seen ? ` for "${seen}"` : ''}. Move closer, cut the glare, or connect Claude or ChatGPT in Settings.`, { error: true });
      return;
    }
    countScan();
    state.candidates = cands;
    state.confidence = confidenceOf(cands);
    setStatus('Getting prices…', { busy: true });
    await openCard(cands[0].id);
    idleStatus();
    if (state.confidence === 'guess') openCardChooser(true);
  } catch (e) {
    setStatus(e.message || 'Something went wrong. Try again.', { error: true });
  } finally {
    state.busy = false;
    els.guide.classList.remove('captured');
    renderDock();
  }
}

function countScan() {
  state.scans += 1; storageSet('pokescan.scans', state.scans);
  if (state.scans >= 2) setHelp(false);
}

/** One item from the AI: open its result sheet. */
async function showSingle(it) {
  setStatus('Finding match…', { busy: true });
  if (it.kind === 'sealed') {
    const cands = await findSealed({ name: it.name, set: it.set_name, type: it.product_type });
    if (!cands.length) { setStatus(`Couldn't find "${it.name}" in TCGplayer's sealed list. Try Search → Sealed.`, { error: true }); return; }
    state.candidates = cands;
    state.confidence = sealedConfidence(cands);
    openSealed(cands[0]);
    idleStatus();
    if (state.confidence === 'guess') openSealedChooser(true);
    return;
  }
  const cands = await findCandidates(hintsFromItem(it));
  if (!cands.length) { setStatus(`Read "${it.name} ${it.number}" but couldn't match it. Try Search.`, { error: true }); return; }
  state.candidates = cands;
  state.confidence = confidenceOf(cands);
  setStatus('Getting prices…', { busy: true });
  await openCard(cands[0].id);
  idleStatus();
  if (state.confidence === 'guess') openCardChooser(true);
}

function onScan() {
  if (!state.stream) { startCamera(); return; }
  if (state.busy || !els.video.videoWidth) return;
  if (state.mode === 'multi') {
    if (!activeAI()) return renderMode();
    grabFull().then((c) => identify(c, { wide: true }));
  } else {
    identify(grabGuide());
  }
}

function scanFile(file) {
  if (!file) return;
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    stopCamera();
    els.video.hidden = true;
    els.stageEmpty.hidden = true;
    els.still.src = url;
    els.still.hidden = false;
    renderMode();
    const c = document.createElement('canvas');
    const k = Math.min(1, 3000 / Math.max(img.width, img.height));
    c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    // A photo can hold several cards or a sealed box, so let the AI see all of it when it's available.
    identify(c, { wide: !!activeAI() });
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
    else { els.stageEmpty.hidden = false; renderMode(); renderDock(); }
  }
  idleStatus();
}

/* ---------- scan mode ---------- */

function setMode(mode) {
  state.mode = mode;
  storageSet('pokescan.mode', mode);
  renderMode();
  idleStatus();
  renderDock();
}

function renderMode() {
  els.modes.querySelectorAll('button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.mode === state.mode)));
  const multi = state.mode === 'multi';
  els.stage.classList.toggle('multi', multi);
  els.guide.hidden = !state.stream;
  els.needsAi.hidden = !(multi && !activeAI() && els.still.hidden);
  els.aiTip.hidden = !!activeAI();
  els.helpBtn.hidden = !state.stream || multi;
}

/* ---------- result sheet ---------- */

async function openCard(id, { demo = false } = {}) {
  const card = await getJSON(`${API}/cards/${encodeURIComponent(id)}`);
  state.card = card;
  state.sealed = null;
  const printings = printingsOf(card);
  // Only pre-select when there is exactly one printing; never carry the last card's choice over.
  state.printing = printings.length === 1 ? printings[0] : null;
  state.detailsOpen = false;
  if (demo) state.confidence = 'demo';
  renderSheet();
  showSheet();
}

function openSealed(product) {
  state.sealed = product;
  state.card = null;
  state.printing = null;
  state.detailsOpen = false;
  renderSheet();
  showSheet();
}

function showSheet() {
  els.sheet.classList.remove('closed');
  els.sheet.setAttribute('aria-hidden', 'false');
  renderDock();
}

function closeSheet() {
  els.sheet.classList.add('closed');
  els.sheet.setAttribute('aria-hidden', 'true');
  state.card = null;
  state.sealed = null;
  renderDock();
}

function numberText(c) {
  const total = c.set?.cardCount?.official;
  return total && /^\d+$/.test(c.localId) ? `${c.localId}/${String(total).padStart(String(c.localId).length, '0')}` : c.localId;
}

const inBinder = (id) => state.collection.some((e) => e.id === id);
const confChip = () => ({ strong: '<span class="chip good">Match</span>', guess: '<span class="chip warn">Best guess</span>', picked: '<span class="chip good">Your pick</span>', demo: '<span class="chip info">Demo</span>' }[state.confidence] || '');
const chevron = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></svg>`;

function renderSheet() {
  if (state.sealed) return renderSealedSheet();
  const c = state.card;
  if (!c) return;
  const printings = printingsOf(c);
  const tp = c.pricing?.tcgplayer, cm = c.pricing?.cardmarket;
  const updated = tp?.updated || cm?.updated;
  const updatedText = updated ? new Date(updated).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : null;
  const src = source();

  const chips = confChip() + (state.confidence !== 'demo' && !inBinder(c.id) ? '<span class="chip new">New find</span>' : '');

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

    <button class="row-btn" type="button" id="detailsBtn" aria-expanded="${state.detailsOpen}" aria-controls="details">Price details ${chevron('M6 9l6 6 6-6')}</button>
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

    ${multiple ? `<button class="row-btn" type="button" id="wrongBtn">Wrong card? Choose another ${chevron('M9 6l6 6-6 6')}</button>` : ''}
  `;

  els.sheetBody.querySelectorAll('.printing').forEach((b) => b.addEventListener('click', () => { state.printing = b.dataset.p; renderSheet(); renderDock(); }));
  $('#detailsBtn').addEventListener('click', () => { state.detailsOpen = !state.detailsOpen; renderSheet(); });
  $('#wrongBtn')?.addEventListener('click', () => openCardChooser(false));
  $('#thumbBtn').addEventListener('click', () => c.image && openLightbox(imgUrl(c.image, 'high'), c.name));
}

let sealedUpdated = null;
function renderSealedSheet() {
  const p = state.sealed;
  getSealed().then((d) => { sealedUpdated = d.updated; }).catch(() => {});
  const updatedText = sealedUpdated ? new Date(sealedUpdated).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : null;
  const id = 'tcg:' + p.pid;
  const chips = '<span class="chip info">Sealed</span>' + confChip() + (!inBinder(id) ? '<span class="chip new">New find</span>' : '');
  const year = p.released ? p.released.slice(0, 4) : '';
  const ebayLink = `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(p.name + ' sealed')}&LH_Sold=1&LH_Complete=1`;

  els.sheetBody.innerHTML = `
    <div class="ident">
      <button class="thumb" type="button" id="thumbBtn" aria-label="View the product larger"><img class="sealed-img" src="${esc(sealedImg(p.pid))}" alt="${esc(p.name)}"></button>
      <div class="ident-meta">
        <div class="chips">${chips}</div>
        <h2 class="card-name">${esc(p.name)}</h2>
        <p class="card-sub">${esc(p.group.replace(/^[A-Z0-9]+:\s*/, ''))}${year ? ' · ' + esc(year) : ''}</p>
      </div>
    </div>
    <div class="price">
      <span class="price-label">TCGplayer market · USD</span>
      ${p.market != null ? `<span class="price-main">${usd(p.market)}</span>` : '<span class="price-main none">Price unavailable</span>'}
      <span class="price-note">Factory sealed${updatedText ? ` · Updated ${esc(updatedText)}` : ''}</span>
    </div>
    <button class="row-btn" type="button" id="detailsBtn" aria-expanded="${state.detailsOpen}" aria-controls="details">Price details ${chevron('M6 9l6 6 6-6')}</button>
    <div class="details" id="details" ${state.detailsOpen ? '' : 'hidden'}>
      <div class="price-table">
        <h3><span>TCGplayer listings</span><span>USD</span></h3>
        <dl>
          <dt>Market</dt><dd>${usd(p.market)}</dd>
          <dt>Low</dt><dd>${usd(p.low)}</dd>
          <dt>Mid</dt><dd>${usd(p.mid)}</dd>
          <dt>High</dt><dd>${usd(p.high)}</dd>
        </dl>
      </div>
      <div class="links">
        <a class="btn" href="https://www.tcgplayer.com/product/${p.pid}" target="_blank" rel="noopener">TCGplayer</a>
        <a class="btn" href="${esc(ebayLink)}" target="_blank" rel="noopener">eBay sold</a>
      </div>
    </div>
    ${state.candidates.length > 1 ? `<button class="row-btn" type="button" id="wrongBtn">Wrong product? Choose another ${chevron('M9 6l6 6-6 6')}</button>` : ''}
  `;
  $('#detailsBtn').addEventListener('click', () => { state.detailsOpen = !state.detailsOpen; renderSheet(); });
  $('#wrongBtn')?.addEventListener('click', () => openSealedChooser(false));
  $('#thumbBtn').addEventListener('click', () => openLightbox(sealedImg(p.pid, true), p.name));
}

function openLightbox(src, alt) {
  els.lightboxImg.src = src;
  els.lightboxImg.alt = alt;
  els.lightbox.hidden = false;
}

/* ---------- dock ---------- */

function renderDock() {
  const showResult = (!!state.card || !!state.sealed) && !els.sheet.classList.contains('closed');
  els.dockReady.hidden = showResult;
  els.dockResult.hidden = !showResult;
  if (showResult) {
    const needPrinting = !!state.card && printingsOf(state.card).length > 1 && !state.printing;
    els.addBtn.disabled = state.saving || needPrinting || state.confidence === 'demo';
    els.addBtn.textContent = state.confidence === 'demo' ? 'Demo card' : needPrinting ? 'Choose printing' : 'Add & next';
    els.skipBtn.textContent = state.confidence === 'demo' ? 'Close' : 'Skip';
  } else {
    els.scanBtn.disabled = state.busy;
    const label = state.mode === 'multi' ? 'Scan all' : 'Scan';
    els.scanBtn.innerHTML = state.busy ? '<span class="spin"></span> Scanning…'
      : state.stream ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2"/><circle cx="12" cy="12" r="3"/></svg> ${label}`
      : 'Start camera';
  }
}

/* ---------- chooser ---------- */

function cardRow(c, current) {
  return `<button type="button" class="list-row" data-id="${esc(c.id)}" aria-current="${current}">
    ${c.image ? `<img loading="lazy" src="${esc(imgUrl(c.image, 'low'))}" alt="">` : '<div class="ph"></div>'}
    <span class="t"><span class="n">${esc(c.name)}</span><span class="s">${esc(c.set?.name || setIdOf(c.id))} · #${esc(c.localId)}</span></span>
    <span></span>
  </button>`;
}
function sealedRow(p, current) {
  return `<button type="button" class="list-row" data-id="${p.pid}" aria-current="${current}">
    <img loading="lazy" class="sealed-img" src="${esc(sealedImg(p.pid))}" alt="">
    <span class="t"><span class="n">${esc(p.name)}</span><span class="s">${esc(p.group)}</span></span>
    <span class="v"><span class="usd mono">${p.market != null ? usd(p.market) : '—'}</span></span>
  </button>`;
}

function openPanel(p) { p.hidden = false; }
function closePanel(p) { p.hidden = true; }

function openChooser({ note, html, onPick }) {
  els.chooserNote.textContent = note;
  els.chooserList.innerHTML = html;
  state.chooserPick = onPick;
  openPanel(els.chooser);
}

function openCardChooser(auto) {
  openChooser({
    note: auto ? "The scan wasn't certain. Tap the card that matches yours." : 'Tap the card that matches yours.',
    html: state.candidates.map((c) => cardRow(c, state.card && c.id === state.card.id)).join(''),
    onPick: async (id) => { state.confidence = 'picked'; await openCard(id); },
  });
}

function openSealedChooser(auto) {
  openChooser({
    note: auto ? "The scan wasn't certain. Tap the product that matches yours." : 'Tap the product that matches yours.',
    html: state.candidates.map((p) => sealedRow(p, state.sealed && p.pid === state.sealed.pid)).join(''),
    onPick: (pid) => { state.confidence = 'picked'; openSealed(state.candidates.find((p) => String(p.pid) === pid)); },
  });
}

els.chooserList.addEventListener('click', async (ev) => {
  const row = ev.target.closest('.list-row');
  if (!row || !state.chooserPick) return;
  closePanel(els.chooser);
  try { await state.chooserPick(row.dataset.id); } catch (e) { setStatus(e.message, { error: true }); }
});

/* ---------- search ---------- */

function setSearchKind(kind) {
  state.searchKind = kind;
  els.searchPanel.querySelectorAll('.seg button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.kind === kind)));
  els.searchInput.placeholder = kind === 'sealed' ? '151 elite trainer box' : 'Charizard 4/102';
  els.searchNote.textContent = kind === 'sealed'
    ? 'Type the set and product, e.g. "Prismatic Evolutions booster bundle".'
    : 'Type the name, and the number from the bottom corner if you have it.';
  els.searchList.innerHTML = '';
  if (els.searchInput.value.trim()) runSearch(els.searchInput.value);
}

function openSearch(kind, q = '') {
  openPanel(els.searchPanel);
  if (q) els.searchInput.value = q;
  setSearchKind(kind);
  setTimeout(() => els.searchInput.focus(), 50);
}

async function runSearch(q) {
  q = q.trim();
  if (!q) return;
  els.searchNote.textContent = 'Searching…';
  els.searchList.innerHTML = '';
  try {
    let cands;
    if (state.searchKind === 'sealed') {
      cands = await findSealed({ name: q });
      if (!cands.length) { els.searchNote.textContent = `No sealed products found for "${q}". Try the set name plus the product type.`; return; }
      els.searchList.innerHTML = cands.map((p) => sealedRow(p, false)).join('');
    } else {
      const num = parseNumber(q) || (q.match(/\b\d{1,3}\b/) ? { prefix: '', n: parseInt(q.match(/\b(\d{1,3})\b/)[1], 10), total: null } : null);
      const namePart = q.replace(/[A-Z]{0,4}\d{1,3}\s*\/\s*[A-Z]{0,4}\d{1,3}/gi, ' ').replace(/\b\d{1,3}\b/g, ' ').replace(/#/g, ' ').trim();
      cands = await findCandidates({ exactNames: namePart ? [namePart] : [], names: nameTokens(namePart), num, text: namePart });
      if (!cands.length) { els.searchNote.textContent = `No cards found for "${q}". Check the spelling, or try just the name.`; return; }
      els.searchList.innerHTML = cands.map((c) => cardRow(c, false)).join('');
    }
    state.candidates = cands;
    els.searchNote.textContent = `${cands.length} match${cands.length === 1 ? '' : 'es'}. Tap yours.`;
  } catch (e) {
    els.searchNote.textContent = e.message || 'Search failed. Try again.';
  }
}

els.searchList.addEventListener('click', async (ev) => {
  const row = ev.target.closest('.list-row');
  if (!row) return;
  closePanel(els.searchPanel);
  state.confidence = 'picked';
  try {
    if (state.searchKind === 'sealed') openSealed(state.candidates.find((p) => String(p.pid) === row.dataset.id));
    else await openCard(row.dataset.id);
  } catch (e) { setStatus(e.message, { error: true }); }
});

/* ---------- multi-scan results ---------- */

async function showBatch(items) {
  setStatus(`Matching ${items.length} items…`, { busy: true });
  const batch = await Promise.all(items.map(async (ai) => {
    const b = { ai, kind: ai.kind, cands: [], card: null, product: null, printing: null, include: false };
    try {
      if (ai.kind === 'sealed') {
        b.cands = await findSealed({ name: ai.name, set: ai.set_name, type: ai.product_type });
        b.product = b.cands[0] || null;
      } else {
        b.cands = await findCandidates(hintsFromItem(ai));
        if (b.cands.length) {
          b.card = await getJSON(`${API}/cards/${encodeURIComponent(b.cands[0].id)}`);
          b.printing = printingsOf(b.card)[0] || null;
        }
      }
    } catch { /* leave unmatched */ }
    b.include = !!(b.card || b.product);
    return b;
  }));
  state.batch = batch;
  renderBatch();
  openPanel(els.batchPanel);
  idleStatus();
}

const batchValue = (b) => (b.product ? b.product.market : b.card ? valuesFor(b.card, b.printing).usd : null);

function renderBatch() {
  const b = state.batch;
  const matched = b.filter((x) => x.card || x.product).length;
  const chosen = b.filter((x) => x.include);
  const total = chosen.reduce((s, x) => s + (batchValue(x) ?? 0), 0);
  els.batchTitle.textContent = `Found ${b.length} item${b.length === 1 ? '' : 's'}`;
  els.batchNote.textContent = matched < b.length
    ? `${b.length - matched} couldn't be matched. Tap them to search. Untick anything you don't want.`
    : 'Untick anything you don\'t want. Tap an item to fix the match.';
  els.batchList.innerHTML = b.map((x, i) => {
    const ok = x.card || x.product;
    const img = x.product ? `<img class="sealed-img" src="${esc(sealedImg(x.product.pid))}" alt="">`
      : x.card?.image ? `<img src="${esc(imgUrl(x.card.image, 'low'))}" alt="">` : '<div class="ph"></div>';
    let sub;
    if (x.product) sub = `<span class="s">Sealed · ${esc(x.product.group.replace(/^[A-Z0-9]+:\s*/, ''))}</span>`;
    else if (x.card) {
      const pr = printingsOf(x.card);
      sub = `<span class="s">${esc(x.card.set?.name || '')} · #${esc(numberText(x.card))}</span>` +
        (pr.length > 1 ? `<select data-i="${i}" aria-label="Printing for ${esc(x.card.name)}">${pr.map((p) => `<option value="${esc(p)}"${p === x.printing ? ' selected' : ''}>${esc(printingLabel(p))}</option>`).join('')}</select>` : '');
    } else sub = `<span class="miss">No match for “${esc(x.ai.name || 'unknown')}”. Tap to search.</span>`;
    const val = batchValue(x);
    return `<div class="list-row batch-row${x.include ? '' : ' off'}">
      <button type="button" class="check" role="checkbox" aria-checked="${x.include}" data-act="toggle" data-i="${i}" ${ok ? '' : 'disabled'} aria-label="Include ${esc((x.card || x.product)?.name || x.ai.name)}"><span></span></button>
      <span data-act="fix" data-i="${i}" style="cursor:pointer">${img}</span>
      <span class="t" data-act="fix" data-i="${i}" style="cursor:pointer"><span class="n">${esc((x.card || x.product)?.name || x.ai.name || 'Unknown item')}</span>${sub}</span>
      <span class="v"><span class="usd mono">${ok ? (val != null ? usd(val) : 'No price') : ''}</span></span>
    </div>`;
  }).join('');
  els.batchAdd.disabled = !chosen.length;
  els.batchAdd.textContent = chosen.length ? `Add ${chosen.length} · ${usd(total)}` : 'Nothing selected';
}

els.batchList.addEventListener('click', (ev) => {
  const t = ev.target.closest('[data-act]');
  if (!t || ev.target.closest('select')) return;
  const i = +t.dataset.i, x = state.batch[i];
  if (!x) return;
  if (t.dataset.act === 'toggle') { x.include = !x.include; renderBatch(); return; }
  // Fix the match: pick from the alternatives, or search when nothing matched.
  if (!x.cands.length) {
    closePanel(els.batchPanel);
    openSearch(x.kind === 'sealed' ? 'sealed' : 'card', [x.ai.name, x.ai.set_name, x.ai.product_type].filter(Boolean).join(' '));
    return;
  }
  openChooser({
    note: `Which one is it? We read “${[x.ai.name, x.ai.number].filter(Boolean).join(' ')}”.`,
    html: x.kind === 'sealed'
      ? x.cands.map((p) => sealedRow(p, x.product && p.pid === x.product.pid)).join('')
      : x.cands.map((c) => cardRow(c, x.card && c.id === x.card.id)).join(''),
    onPick: async (id) => {
      if (x.kind === 'sealed') x.product = x.cands.find((p) => String(p.pid) === id);
      else { x.card = await getJSON(`${API}/cards/${encodeURIComponent(id)}`); x.printing = printingsOf(x.card)[0] || null; }
      x.include = true;
      renderBatch();
    },
  });
});

els.batchList.addEventListener('change', (ev) => {
  const sel = ev.target.closest('select[data-i]');
  if (!sel) return;
  state.batch[+sel.dataset.i].printing = sel.value;
  renderBatch();
});

function addBatch() {
  const chosen = state.batch.filter((x) => x.include && (x.card || x.product));
  if (!chosen.length) return;
  const adds = chosen.map((x) => (x.product ? addSealedEntry(x.product) : addCardEntry(x.card, x.printing)));
  saveCollection();
  const total = chosen.reduce((s, x) => s + (batchValue(x) ?? 0), 0);
  const anyNew = adds.some((a) => a.isNew);
  closePanel(els.batchPanel);
  celebrate(`Added ${chosen.length} item${chosen.length === 1 ? '' : 's'} · ${usd(total)}`, anyNew, adds);
  backToCamera();
}

/* ---------- binder ---------- */

function entryKey(e) { return e.id + '|' + (e.printing || ''); }

function addCardEntry(c, printing) {
  const isNew = !inBinder(c.id);
  const vals = valuesFor(c, printing);
  const key = c.id + '|' + (printing || '');
  let entry = state.collection.find((e) => entryKey(e) === key);
  const created = !entry;
  if (entry) { entry.qty += 1; entry.usd = vals.usd; entry.eur = vals.eur; }
  else {
    entry = { kind: 'card', id: c.id, name: c.name, set: c.set?.name || '', localId: c.localId, number: numberText(c), image: c.image || '',
      thumb: imgUrl(c.image, 'low'), printing, usd: vals.usd, eur: vals.eur, qty: 1, added: Date.now() };
    state.collection.unshift(entry);
  }
  return { key, created, isNew, entry };
}

function addSealedEntry(p) {
  const id = 'tcg:' + p.pid;
  const isNew = !inBinder(id);
  const key = id + '|';
  let entry = state.collection.find((e) => entryKey(e) === key);
  const created = !entry;
  if (entry) { entry.qty += 1; entry.usd = p.market; }
  else {
    entry = { kind: 'sealed', id, pid: p.pid, name: p.name, set: p.group.replace(/^[A-Z0-9]+:\s*/, ''), number: '', thumb: sealedImg(p.pid),
      printing: null, usd: p.market, eur: null, qty: 1, added: Date.now() };
    state.collection.unshift(entry);
  }
  return { key, created, isNew, entry };
}

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
    label.textContent = count ? `Binder · ${count} item${count === 1 ? '' : 's'}` : 'Binder · empty';
    label.classList.remove('added');
  }
  els.stripTotal.textContent = count ? (source() === 'cm' ? eur(totalEur) : usd(totalUsd)) : '';
}

function flyToStrip(fromEl) {
  if (reducedMotion() || !fromEl) return;
  const a = fromEl.getBoundingClientRect(), b = els.strip.getBoundingClientRect();
  const fly = fromEl.cloneNode();
  fly.className = 'flyer';
  Object.assign(fly.style, { left: a.left + 'px', top: a.top + 'px', width: a.width + 'px', height: a.height + 'px' });
  document.body.appendChild(fly);
  const dx = b.left + 30 - (a.left + a.width / 2), dy = b.top + b.height / 2 - (a.top + a.height / 2);
  fly.animate(
    [{ transform: 'translate(0,0) scale(1)', opacity: 1 }, { transform: `translate(${dx}px, ${dy}px) scale(.28)`, opacity: 0.5 }],
    { duration: 190, easing: 'cubic-bezier(.3,.7,.4,1)' },
  ).finished.finally(() => fly.remove());
}

/** Shared feedback after anything lands in the binder: strip message, glint, haptic, sound, and a 7-second Undo. */
function celebrate(text, isNew, adds) {
  haptic();
  chime();
  renderStrip(text);
  els.strip.classList.remove('glint', 'pop'); void els.strip.offsetWidth;
  els.strip.classList.add(isNew && !reducedMotion() ? 'glint' : 'pop');
  state.lastAdd = adds.map((a) => ({ key: a.key, created: a.created }));
  els.undoBtn.hidden = false;
  clearTimeout(state.undoTimer);
  state.undoTimer = setTimeout(endUndo, 7000);
}

function addAndNext() {
  if (state.saving || state.confidence === 'demo') return;
  const c = state.card, p = state.sealed;
  if (!c && !p) return;
  if (c && printingsOf(c).length > 1 && !state.printing) return;
  state.saving = true;
  renderDock();
  const add = c ? addCardEntry(c, state.printing) : addSealedEntry(p);
  saveCollection();
  flyToStrip(els.sheetBody.querySelector('.thumb img'));
  celebrate(`${add.isNew ? 'New find · ' : ''}Added · ${add.entry.name} ×${add.entry.qty}`, add.isNew, [add]);
  state.saving = false;
  backToCamera();
}

function endUndo() {
  els.undoBtn.hidden = true;
  state.lastAdd = null;
  renderStrip();
}

function undoAdd() {
  const adds = state.lastAdd;
  if (!adds) return;
  for (const la of adds) {
    const i = state.collection.findIndex((e) => entryKey(e) === la.key);
    if (i < 0) continue;
    if (la.created || state.collection[i].qty <= 1) state.collection.splice(i, 1);
    else state.collection[i].qty -= 1;
  }
  saveCollection();
  clearTimeout(state.undoTimer);
  els.undoBtn.hidden = true;
  state.lastAdd = null;
  renderStrip(adds.length > 1 ? `Removed those ${adds.length} items` : 'Removed the last item');
  setTimeout(() => { if (!state.lastAdd) renderStrip(); }, 1800);
  if (!els.binderPanel.hidden) renderBinder();
}

function renderBinder() {
  const col = state.collection;
  const { count, totalUsd, totalEur, priced } = binderStats();
  const cm = source() === 'cm';
  if (!col.length) {
    els.binderBody.innerHTML = '<p class="empty-note">Nothing here yet. Scan a card or sealed product and tap <b>Add &amp; next</b> to start your binder.</p>';
    return;
  }
  els.binderBody.innerHTML = `
    <div class="binder-sum">
      <span class="price-label">${cm ? 'Cardmarket trend · EUR' : 'TCGplayer market · USD'}</span>
      <span class="big">${cm ? eur(totalEur) : usd(totalUsd)}</span>
      <span class="eur">${cm ? usd(totalUsd) : eur(totalEur)} <small class="price-label">${cm ? 'TCGplayer market · USD' : 'Cardmarket trend · EUR (cards only)'}</small></span>
      <span class="meta">${count} item${count === 1 ? '' : 's'} · ${priced} of ${count} priced</span>
    </div>
    <div class="list">
      ${col.map((e, i) => `
        <div class="list-row binder-row">
          <img loading="lazy" ${e.kind === 'sealed' ? 'class="sealed-img"' : ''} src="${esc(thumbOf(e))}" alt="">
          <span class="t">
            <span class="n">${esc(e.name)}</span>
            <span class="s">${e.kind === 'sealed' ? 'Sealed · ' + esc(e.set) : `${e.printing ? esc(printingLabel(e.printing)) + ' · ' : ''}${esc(e.set)} #${esc(e.number || e.localId)}`}</span>
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
      <span class="confirm">Remove all ${count} items from the binder?</span>
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
  let sealed = null;
  for (let i = 0; i < state.collection.length; i++) {
    const e = state.collection[i];
    btn.textContent = `Refreshing ${i + 1}/${state.collection.length}…`;
    try {
      if (e.kind === 'sealed') {
        sealed = sealed || (sealedPromise = null, await getSealed());
        const p = sealed.products.find((x) => x.pid === e.pid);
        if (p) e.usd = p.market; else failed++;
      } else {
        const card = await getJSON(`${API}/cards/${encodeURIComponent(e.id)}`);
        const vals = valuesFor(card, e.printing || printingsOf(card)[0]);
        e.usd = vals.usd; e.eur = vals.eur;
      }
    } catch { failed++; }
  }
  saveCollection();
  renderBinder();
  renderStrip(failed ? `${failed} item${failed === 1 ? '' : 's'} couldn't refresh` : 'Prices refreshed');
  setTimeout(() => renderStrip(), 2200);
}

function exportCsv() {
  const rows = [['Type', 'Name', 'Set', 'Number', 'Printing', 'Qty', 'TCGplayer market (USD)', 'Cardmarket trend (EUR)', 'Total USD', 'Total EUR', 'ID']];
  for (const e of state.collection) {
    rows.push([e.kind === 'sealed' ? 'Sealed' : 'Card', e.name, e.set, e.number || e.localId || '', e.printing ? printingLabel(e.printing) : '', e.qty, e.usd ?? '', e.eur ?? '',
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

function openSettings() {
  els.apiKey.value = claudeKey();
  els.openaiKey.value = openaiKey();
  els.openaiModel.value = storageGet('pokescan.openaiModel', '');
  els.soundOpt.checked = soundOn();
  const prov = storageGet('pokescan.provider', null) || (claudeKey() ? 'claude' : openaiKey() ? 'openai' : 'claude');
  els.settings.querySelectorAll('input[name=provider]').forEach((r) => { r.checked = r.value === prov; });
  els.settings.querySelectorAll('input[name=source]').forEach((r) => { r.checked = r.value === source(); });
  els.settingsErr.hidden = true;
  syncKeyFields();
  els.settings.showModal();
}

function syncKeyFields() {
  const p = els.settings.querySelector('input[name=provider]:checked')?.value;
  $('#claudeField').hidden = p !== 'claude';
  $('#openaiField').hidden = p !== 'openai';
  $('#openaiModelField').hidden = p !== 'openai';
}

els.settings.addEventListener('change', (e) => { if (e.target.name === 'provider') { els.settingsErr.hidden = true; syncKeyFields(); } });
els.settings.querySelector('form').addEventListener('submit', (e) => {
  if (e.submitter?.value !== 'save') return;
  const p = els.settings.querySelector('input[name=provider]:checked')?.value;
  const missing = (p === 'claude' && !els.apiKey.value.trim()) || (p === 'openai' && !els.openaiKey.value.trim());
  if (missing) {
    e.preventDefault();
    els.settingsErr.textContent = `Paste your ${p === 'claude' ? 'Anthropic' : 'OpenAI'} API key, or choose On-device.`;
    els.settingsErr.hidden = false;
  }
});
els.settings.addEventListener('close', () => {
  if (els.settings.returnValue !== 'save') return;
  storageSet('pokescan.apiKey', els.apiKey.value.trim());
  storageSet('pokescan.openaiKey', els.openaiKey.value.trim());
  storageSet('pokescan.openaiModel', els.openaiModel.value.trim());
  storageSet('pokescan.sound', els.soundOpt.checked);
  const prov = els.settings.querySelector('input[name=provider]:checked');
  if (prov) storageSet('pokescan.provider', prov.value);
  const s = els.settings.querySelector('input[name=source]:checked');
  if (s) storageSet('pokescan.source', s.value);
  renderStrip();
  renderMode();
  idleStatus();
  if (state.card || state.sealed) renderSheet();
  if (!els.binderPanel.hidden) renderBinder();
});

/* ---------- wiring ---------- */

els.scanBtn.addEventListener('click', onScan);
els.searchBtn.addEventListener('click', () => openSearch(state.mode === 'multi' ? 'sealed' : state.searchKind));
els.searchPanel.querySelectorAll('.seg button').forEach((b) => b.addEventListener('click', () => setSearchKind(b.dataset.kind)));
els.searchForm.addEventListener('submit', (e) => { e.preventDefault(); els.searchInput.blur(); runSearch(els.searchInput.value); });
els.fileInput.addEventListener('change', () => { scanFile(els.fileInput.files[0]); els.fileInput.value = ''; });
els.skipBtn.addEventListener('click', backToCamera);
els.addBtn.addEventListener('click', addAndNext);
els.undoBtn.addEventListener('click', undoAdd);
els.batchAdd.addEventListener('click', addBatch);
els.batchRescan.addEventListener('click', () => { closePanel(els.batchPanel); backToCamera(); });
els.stripMain.addEventListener('click', () => { renderBinder(); openPanel(els.binderPanel); });
els.helpBtn.addEventListener('click', () => setHelp(!els.guide.classList.contains('help')));
els.modes.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
els.needsAiSetup.addEventListener('click', openSettings);
els.aiTipBtn.addEventListener('click', openSettings);
els.needsAiSearch.addEventListener('click', () => openSearch('sealed'));
els.settingsBtn.addEventListener('click', openSettings);
els.lightbox.addEventListener('click', () => { els.lightbox.hidden = true; });
els.demoBtn.addEventListener('click', async () => {
  state.candidates = [];
  try { await openCard('base1-4', { demo: true }); } catch (e) { setStatus(e.message, { error: true }); }
});
document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => closePanel($('#' + b.dataset.close))));

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!els.lightbox.hidden) { els.lightbox.hidden = true; return; }
    const open = [els.chooser, els.searchPanel, els.batchPanel, els.binderPanel].find((p) => !p.hidden);
    if (open) { closePanel(open); return; }
    if (state.card || state.sealed) backToCamera();
    return;
  }
  if (e.code === 'Space' && !e.target.closest('input, textarea, select, button, a, dialog') && !state.card && !state.sealed) {
    e.preventDefault();
    onScan();
  }
});

// Drop a photo anywhere on the camera.
els.stage.addEventListener('dragover', (e) => e.preventDefault());
els.stage.addEventListener('drop', (e) => { e.preventDefault(); scanFile(e.dataTransfer.files[0]); });

renderStrip();
renderMode();
renderDock();
setStatus('');
getSets().catch(() => {});
// Open straight into the camera if the person already allowed it here before.
(async () => {
  let granted = false;
  try { granted = (await navigator.permissions?.query({ name: 'camera' }))?.state === 'granted'; } catch { /* unsupported */ }
  if (granted || storageGet('pokescan.camOk', false)) startCamera();
})();
