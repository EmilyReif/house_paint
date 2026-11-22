'use strict';

// Masks are pre-aligned to their photos by tools/edit_mask*.js, so they're just stretched to fit.
const HOUSES = [
  { name: 'Front', photo: 'images/house.jpeg', mask: 'images/mask.png' },
  // crop (photo px) trims sky/grass for display; the mask is cropped to match.
  // Keep its aspect = the front photo (1024:604) so the stacked images line up at the same width.
  { name: 'Back', photo: 'images/house2.png', mask: 'images/mask2.png', crop: { x: 0, y: 118, w: 1436, h: 847 } },
];
const REGIONS = [
  { key: 'siding', label: 'Siding' },
  { key: 'trim', label: 'Trim' },
  { key: 'accent', label: 'Accents' },
];
const STORAGE_KEY = 'housePaint.v1';
const HEX_RE = /^#[0-9a-f]{6}$/i;
const SHADING = 1.5; // how strongly the photo's light/shadow modulates the paint (1 = proportional)

const state = {
  colors: { siding: '#D8C3A0', trim: '#3B3A36', accent: '#9E2B25' },
  saved: [],
  split: 0.1,    // 0..1: left of this fraction of the width shows the original photo
};

// ---------- color helpers ----------
const srgbToLin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const linToSrgb = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);
const LIN_LUT = new Float32Array(256).map((_, i) => srgbToLin(i / 255));
const OUT_LUT = new Uint8ClampedArray(4096).map((_, i) => Math.round(linToSrgb(i / 4095) * 255)); // linear -> srgb byte
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

function hexToSrgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
function hslToHex(h, s, l) {
  const f = (n) => {
    const k = (n + h / 30) % 12;
    const c = l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(c * 255).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`.toUpperCase();
}
// ---------- image data (one "view" per photo) ----------
// Each view: { canvas, ctx, W, H, photoPixels, outImage, photoLin, lumLin, alpha, refLin }
const views = [];

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to load ' + src));
    img.src = src;
  });
}

async function init() {
  loadState();
  buildRegionControls();
  buildPresets();
  renderSaved();
  wireControls();
  const host = document.getElementById('views');
  const loaded = await Promise.all(HOUSES.map(loadView));
  for (const v of loaded) { host.appendChild(v.canvas); wireSplit(v); }
  // line/knob thickness depends on displayed size
  new ResizeObserver(() => views.forEach(composite)).observe(host);
  views.push(...loaded);
  document.getElementById('status').hidden = true;
  render();
}

async function loadView(house) {
  const [photo, mask] = await Promise.all([loadImage(house.photo), loadImage(house.mask)]);
  const PW = photo.naturalWidth, PH = photo.naturalHeight;
  const crop = house.crop || { x: 0, y: 0, w: PW, h: PH };
  const W = crop.w, H = crop.h;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  canvas.setAttribute('aria-label', house.name + ' of house');
  const ctx = canvas.getContext('2d');

  const off = document.createElement('canvas');
  off.width = W; off.height = H;
  const octx = off.getContext('2d', { willReadFrequently: true });
  octx.drawImage(photo, crop.x, crop.y, W, H, 0, 0, W, H);
  const photoPixels = octx.getImageData(0, 0, W, H);
  octx.imageSmoothingQuality = 'high';
  octx.clearRect(0, 0, W, H);
  const mx = mask.naturalWidth / PW, my = mask.naturalHeight / PH; // mask may be a different resolution
  octx.drawImage(mask, crop.x * mx, crop.y * my, W * mx, H * my, 0, 0, W, H);
  const m = octx.getImageData(0, 0, W, H).data;

  const N = W * H, p = photoPixels.data;
  const v = {
    name: house.name, canvas, ctx, W, H, photoPixels, outImage: ctx.createImageData(W, H),
    photoLin: new Float32Array(N * 3), lumLin: new Float32Array(N),
    alpha: new Float32Array(N * 3), refLin: [1, 1, 1],
  };
  for (let i = 0; i < N; i++) {
    for (let c = 0; c < 3; c++) {
      v.photoLin[i * 3 + c] = LIN_LUT[p[i * 4 + c]];
      v.alpha[i * 3 + c] = m[i * 4 + c] / 255;
    }
    v.lumLin[i] = 0.2126 * v.photoLin[i * 3] + 0.7152 * v.photoLin[i * 3 + 1] + 0.0722 * v.photoLin[i * 3 + 2];
  }
  // Reference brightness per region = weighted median, so "typically lit" surfaces show the picked color.
  for (let c = 0; c < 3; c++) v.refLin[c] = weightedMedian(v, c);
  return v;
}

function weightedMedian(v, c) {
  const bins = new Float64Array(1024);
  let total = 0;
  for (let i = 0, N = v.W * v.H; i < N; i++) {
    const a = v.alpha[i * 3 + c];
    if (a > 0.5) { bins[Math.min(1023, (v.lumLin[i] * 1023) | 0)] += a; total += a; }
  }
  let acc = 0;
  for (let b = 0; b < 1024; b++) { acc += bins[b]; if (acc >= total / 2) return Math.max(0.02, (b + 0.5) / 1023); }
  return 0.5;
}


// ---------- rendering ----------
let pending = false;
function render() {
  if (!views.length || pending) return;
  pending = true;
  requestAnimationFrame(() => {
    pending = false;
    for (const v of views) renderView(v);
  });
}

function renderView(v) {
  // Shaded paint: picked color × (pixel brightness / region's typical brightness)^SHADING.
  const { photoLin, lumLin, alpha, refLin } = v;
  const tL = REGIONS.map((r) => hexToSrgb(state.colors[r.key]).map(srgbToLin));
  const k = SHADING;
  const out = v.outImage.data, N = v.W * v.H;
  for (let i = 0; i < N; i++) {
    const i3 = i * 3;
    let r = photoLin[i3], g = photoLin[i3 + 1], b = photoLin[i3 + 2];
    for (let c = 0; c < 3; c++) {
      const a = alpha[i3 + c];
      if (a <= 0.002) continue;
      let s = (lumLin[i] / refLin[c]) ** k;
      if (s > 1.8) s = 1.8;
      const t = tL[c];
      r += (t[0] * s - r) * a; g += (t[1] * s - g) * a; b += (t[2] * s - b) * a;
    }
    const o = i * 4;
    out[o] = OUT_LUT[(clamp01(r) * 4095) | 0];
    out[o + 1] = OUT_LUT[(clamp01(g) * 4095) | 0];
    out[o + 2] = OUT_LUT[(clamp01(b) * 4095) | 0];
    out[o + 3] = 255;
  }
  composite(v);
}

// Painted image, with the original revealed left of the split line (no repaint needed to move it).
function composite(v) {
  const { ctx, W, H } = v;
  ctx.putImageData(v.outImage, 0, 0);
  const sx = Math.round(state.split * W);
  if (sx > 0) ctx.putImageData(v.photoPixels, 0, 0, 0, 0, sx, H);
  // line + knob, sized in screen px regardless of image resolution
  const { scale } = displayRect(v);
  const lw = 2 / scale, kr = 9 / scale, ky = H / 2;
  const kx = Math.min(W - kr - lw, Math.max(kr + lw, sx));
  ctx.save();
  ctx.fillStyle = '#000';
  ctx.fillRect(sx - lw / 2, 0, lw, H);
  ctx.beginPath(); ctx.arc(kx, ky, kr, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#fff';
  const t = kr * 0.45;
  for (const d of [-1, 1]) { // ‹ › arrows
    ctx.beginPath();
    ctx.moveTo(kx + d * t * 0.4, ky - t); ctx.lineTo(kx + d * t * 1.4, ky); ctx.lineTo(kx + d * t * 0.4, ky + t);
    ctx.fill();
  }
  ctx.restore();
}

// Where the image actually sits inside its canvas element (object-fit: contain; object-position: left center).
function displayRect(v) {
  const r = v.canvas.getBoundingClientRect();
  const scale = Math.min(r.width / v.W, r.height / v.H) || 1;
  return { scale, left: r.left, top: r.top + (r.height - v.H * scale) / 2 };
}

function wireSplit(v) {
  const imgX = (e) => { const d = displayRect(v); return (e.clientX - d.left) / d.scale; };
  const near = (e) => Math.abs(imgX(e) - state.split * v.W) * displayRect(v).scale <= 12;
  let dragging = false;
  const move = (e) => {
    state.split = Math.min(1, Math.max(0, imgX(e) / v.W));
    views.forEach(composite);
  };
  v.canvas.addEventListener('pointerdown', (e) => {
    if (!near(e)) return;
    dragging = true;
    v.canvas.setPointerCapture(e.pointerId);
    e.preventDefault();
    move(e);
  });
  v.canvas.addEventListener('pointermove', (e) => {
    if (dragging) move(e);
    else v.canvas.style.cursor = near(e) ? 'ew-resize' : '';
  });
  const end = () => { dragging = false; };
  v.canvas.addEventListener('pointerup', end);
  v.canvas.addEventListener('pointercancel', end);
}

// ---------- UI ----------
const pickers = {};

// Current colors as a bar (same proportions as the combo bars). Each segment is labeled and has an
// invisible <input type=color> stretched over it, so clicking the segment opens the native picker.
// The hex fields sit underneath, aligned to the segments.
function buildRegionControls() {
  const host = document.getElementById('regions');
  const bar = document.createElement('div');
  bar.className = 'current-bar';
  const hexRow = document.createElement('div');
  hexRow.className = 'current-hex';
  REGIONS.forEach((r, idx) => {
    const seg = document.createElement('label');
    seg.className = 'seg sw' + idx;
    const name = document.createElement('span');
    name.textContent = r.label;
    const picker = document.createElement('input');
    picker.type = 'color';
    picker.setAttribute('aria-label', r.label + ' color');
    seg.append(name, picker);
    bar.appendChild(seg);
    const hex = document.createElement('input');
    hex.type = 'text';
    hex.className = 'hex';
    hex.maxLength = 7;
    hex.spellcheck = false;
    hex.classList.add('sw' + idx);
    hex.setAttribute('aria-label', r.label + ' hex');
    picker.addEventListener('input', () => setColor(r.key, picker.value));
    hex.addEventListener('change', () => {
      let v = hex.value.trim();
      if (!v.startsWith('#')) v = '#' + v;
      if (HEX_RE.test(v)) setColor(r.key, v); else hex.value = state.colors[r.key];
    });
    hexRow.appendChild(hex);
    pickers[r.key] = { picker, hex, seg };
  });
  host.append(bar, hexRow);
  syncPickers();
}

function syncPickers() {
  for (const r of REGIONS) {
    const v = state.colors[r.key].toUpperCase();
    const p = pickers[r.key];
    p.picker.value = v.toLowerCase();
    p.hex.value = v;
    p.seg.style.background = v;
    const [cr, cg, cb] = hexToSrgb(v);
    p.seg.style.color = 0.3 * cr + 0.59 * cg + 0.11 * cb > 0.55 ? 'rgba(0,0,0,0.75)' : 'rgba(255,255,255,0.9)';
  }
  if (window.onColorsChanged) window.onColorsChanged(); // formula.js
}

function setColor(key, hex) {
  state.colors[key] = hex.toUpperCase();
  syncPickers(); saveState(); render();
}

function applyCombo(siding, trim, accent) {
  Object.assign(state.colors, { siding, trim, accent });
  syncPickers(); saveState(); render();
}

function comboCard(label, colors, onRemove) {
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'combo';
  card.title = `Siding ${colors[0]} · Trim ${colors[1]} · Accent ${colors[2]}`;
  const num = document.createElement('span');
  num.className = 'num';
  num.textContent = label;
  const sw = document.createElement('span');
  sw.className = 'swatches';
  colors.forEach((c, idx) => {
    const s = document.createElement('span');
    s.className = 'sw sw' + idx;
    s.style.background = c;
    sw.appendChild(s);
  });
  card.append(num, sw);
  card.addEventListener('click', () => applyCombo(...colors));
  if (onRemove) {
    const x = document.createElement('span');
    x.className = 'remove';
    x.textContent = '×';
    x.title = 'Remove';
    x.addEventListener('click', (e) => { e.stopPropagation(); onRemove(); });
    card.appendChild(x);
  }
  return card;
}

function buildPresets() {
  const host = document.getElementById('presets');
  window.PRESETS.forEach((colors, idx) => host.appendChild(comboCard('#' + (idx + 1), colors)));
}

function renderSaved() {
  const host = document.getElementById('saved');
  host.replaceChildren();
  state.saved.forEach((colors, idx) => {
    const card = comboCard('S' + (idx + 1), colors, () => {
      state.saved.splice(idx, 1); saveState(); renderSaved();
    });
    makeReorderable(card, idx);
    host.appendChild(card);
  });
  document.getElementById('savedEmpty').hidden = state.saved.length > 0;
}

// Drag-to-reorder for the saved list (native HTML5 drag and drop).
let dragFrom = -1;
function makeReorderable(card, idx) {
  card.draggable = true;
  const clear = () => card.classList.remove('drop-before', 'drop-after');
  const after = (e) => { const r = card.getBoundingClientRect(); return e.clientY > r.top + r.height / 2; };
  card.addEventListener('dragstart', (e) => {
    dragFrom = idx;
    card.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(idx));
  });
  card.addEventListener('dragend', () => { dragFrom = -1; card.classList.remove('dragging'); });
  card.addEventListener('dragover', (e) => {
    if (dragFrom < 0) return;
    e.preventDefault();
    const a = after(e);
    card.classList.toggle('drop-after', a);
    card.classList.toggle('drop-before', !a);
  });
  card.addEventListener('dragleave', clear);
  card.addEventListener('drop', (e) => {
    e.preventDefault();
    clear();
    if (dragFrom < 0) return;
    let to = idx + (after(e) ? 1 : 0);
    const [item] = state.saved.splice(dragFrom, 1);
    if (dragFrom < to) to--;
    state.saved.splice(to, 0, item);
    dragFrom = -1;
    saveState();
    renderSaved();
  });
}

function randomCombo() {
  const rnd = (a, b) => a + Math.random() * (b - a);
  const h = rnd(0, 360);
  const siding = hslToHex(h, rnd(0.12, 0.4), rnd(0.25, 0.75));
  const trim = Math.random() < 0.5
    ? hslToHex(rnd(38, 50), rnd(0.35, 0.55), rnd(0.84, 0.91)) // cream
    : hslToHex(h + rnd(-30, 30), rnd(0.05, 0.25), rnd(0.12, 0.28));
  const accent = hslToHex((h + rnd(150, 210)) % 360, rnd(0.45, 0.75), rnd(0.3, 0.5));
  applyCombo(siding, trim, accent);
}

function wireControls() {

  document.getElementById('saveCombo').addEventListener('click', () => {
    const c = [state.colors.siding, state.colors.trim, state.colors.accent];
    if (!state.saved.some((s) => s.join() === c.join())) state.saved.push(c);
    saveState(); renderSaved();
  });
  document.getElementById('randomCombo').addEventListener('click', randomCombo);
  document.getElementById('download').addEventListener('click', () => {
    const tag = `${state.colors.siding}-${state.colors.trim}-${state.colors.accent}`.replace(/#/g, '');
    for (const v of views) {
      // export the painted image only (no split line / original)
      const c = document.createElement('canvas');
      c.width = v.W; c.height = v.H;
      c.getContext('2d').putImageData(v.outImage, 0, 0);
      c.toBlob((blob) => {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `house-${v.name.toLowerCase()}-${tag}.png`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      }, 'image/png');
    }
  });
}

// ---------- persistence (non-sensitive UI prefs only) ----------
function loadState() {
  try {
    const s = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    if (s.colors) for (const r of REGIONS) if (HEX_RE.test(s.colors[r.key])) state.colors[r.key] = s.colors[r.key];
    if (Array.isArray(s.saved)) state.saved = s.saved.filter((c) => Array.isArray(c) && c.length === 3 && c.every((x) => HEX_RE.test(x)));
  } catch { /* ignore corrupt storage */ }
}
function saveState() {
  const { colors, saved } = state;
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ colors, saved }));
}

function showLoadError() {
  const status = document.getElementById('status');
  status.hidden = false;
  status.textContent = 'Could not load images. Serve this folder over http (see README) rather than opening the file directly.';
}
init().catch(showLoadError);
