// Cleans up images/mask2_original.jpeg -> images/mask2.png (aligned to images/house2.png).
// Usage (macOS, no deps): node tools/edit_mask2.js
//  - fits the mask to the photo (it was stretched/offset horizontally)
//  - classifies every pixel to the nearest palette color, so grass, bushes, roof and wires become black
//  - windows: blue glass -> black, the green sash/muntins right around the glass -> accent (blue)
//  - other blue: thin bits (railings, downspout) stay accent, solid blobs (dish, skylight) -> black
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'images', 'mask2_original.jpeg');
const PHOTO = path.join(ROOT, 'images', 'house2.png');
const DST = path.join(ROOT, 'images', 'mask2.png');
// photo (x, y) -> mask (x * SX + TX, y * SY + TY); found by edge matching.
const SX = 1.6919, TX = -20, SY = 1.5805, TY = 0.25;
const SASH = 9; // mask px of green around glass that becomes accent (sash + muntins)
const THIN = 6;    // blue thinner than ~2*THIN mask px is a railing/detail, not glass
const OUTLINE = 6; // max width (mask px) of the dark outline Gemini drew around shapes

function readBmp(p) {
  const b = fs.readFileSync(p);
  const off = b.readUInt32LE(10), w = b.readInt32LE(18), hRaw = b.readInt32LE(22), bpp = b.readUInt16LE(28) / 8;
  const h = Math.abs(hRaw), td = hRaw < 0, stride = Math.ceil((w * bpp) / 4) * 4, px = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    const row = off + (td ? y : h - 1 - y) * stride;
    for (let x = 0; x < w; x++) { const i = (y * w + x) * 3, j = row + x * bpp; px[i] = b[j + 2]; px[i + 1] = b[j + 1]; px[i + 2] = b[j]; }
  }
  return { w, h, px };
}
function writeBmp(p, w, h, px) {
  const stride = Math.ceil((w * 3) / 4) * 4, b = Buffer.alloc(54 + stride * h);
  b.write('BM'); b.writeUInt32LE(b.length, 2); b.writeUInt32LE(54, 10); b.writeUInt32LE(40, 14);
  b.writeInt32LE(w, 18); b.writeInt32LE(-h, 22); b.writeUInt16LE(1, 26); b.writeUInt16LE(24, 28);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 3, j = 54 + y * stride + x * 3; b[j] = px[i + 2]; b[j + 1] = px[i + 1]; b[j + 2] = px[i];
  }
  fs.writeFileSync(p, b);
}
const sipsTo = (src, dst, fmt) => execFileSync('sips', ['-s', 'format', fmt, src, '--out', dst], { stdio: 'ignore' });

const BLACK = 0, SIDING = 1, TRIM = 2, ACCENT = 3;
const COLORS = [[0, 0, 0], [255, 0, 0], [0, 255, 0], [0, 0, 255]];
// Colors Gemini used, mapped to our labels.
const PALETTE = [
  [[0, 0, 0], BLACK], [[25, 28, 25], BLACK],          // background, roof/wires
  [[110, 175, 59], BLACK], [[67, 122, 31], BLACK],    // grass, bushes
  [[241, 23, 21], SIDING], [[47, 207, 33], TRIM], [[0, 35, 250], ACCENT],
];

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mask2-'));
sipsTo(SRC, path.join(tmp, 'm.bmp'), 'bmp');
sipsTo(PHOTO, path.join(tmp, 'p.bmp'), 'bmp');
const M = readBmp(path.join(tmp, 'm.bmp'));
const { w: PW, h: PH } = readBmp(path.join(tmp, 'p.bmp'));
const W = M.w, H = M.h, N = W * H;

const lab = new Uint8Array(N);
for (let i = 0; i < N; i++) {
  const r = M.px[i * 3], g = M.px[i * 3 + 1], b = M.px[i * 3 + 2];
  let best = 1e9;
  for (const [[pr, pg, pb], l] of PALETTE) {
    const d = (r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2;
    if (d < best) { best = d; lab[i] = l; }
  }
}

// Split blue into "glass" (thick areas) and thin bits (railings, downspouts...) by morphological opening.
const isBlue = (k) => lab[k] === ACCENT;
function bfsDist(seed, passable, limit) {
  const d = new Int16Array(N).fill(-1), q = new Int32Array(N);
  let h = 0, t = 0;
  for (let k = 0; k < N; k++) if (seed(k)) { d[k] = 0; q[t++] = k; }
  while (h < t) {
    const k = q[h++], x = k % W, y = (k / W) | 0;
    if (d[k] >= limit) continue;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
      const kk = yy * W + xx;
      if (d[kk] < 0 && passable(kk)) { d[kk] = d[k] + 1; q[t++] = kk; }
    }
  }
  return d;
}
const toEdge = bfsDist((k) => !isBlue(k), isBlue, 1e4);           // distance from non-blue
const glassD = bfsDist((k) => toEdge[k] > THIN, isBlue, THIN + 1); // re-grow the thick cores
const isGlass = (k) => glassD[k] >= 0 && glassD[k] <= THIN;

// Connected components of glass.
const comp = new Int32Array(N).fill(-1);
const comps = [];
const stack = new Int32Array(N);
for (let s = 0; s < N; s++) {
  if (!isGlass(s) || comp[s] >= 0) continue;
  const id = comps.length, c = { area: 0, border: [0, 0, 0, 0] };
  let sp = 0; stack[sp++] = s; comp[s] = id;
  while (sp) {
    const k = stack[--sp], x = k % W, y = (k / W) | 0;
    c.area++;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
      const kk = yy * W + xx;
      if (isGlass(kk)) { if (comp[kk] < 0) { comp[kk] = id; stack[sp++] = kk; } continue; }
      // Gemini outlined shapes with a thin dark line: look a few px past it (and past blue fringe).
      let t = 0, xs = xx, ys = yy;
      while (t < OUTLINE + THIN && (lab[ys * W + xs] === BLACK || lab[ys * W + xs] === ACCENT)) {
        xs += dx; ys += dy; t++;
        if (xs < 0 || ys < 0 || xs >= W || ys >= H) { xs -= dx; ys -= dy; break; }
      }
      c.border[lab[ys * W + xs]]++;
    }
  }
  const tot = c.border.reduce((a, v) => a + v, 0);
  c.kind = c.border[TRIM] / tot > 0.5 ? 'window' : 'blob'; // blob = dish, skylight, ...
  comps.push(c);
}
// Thin blue right at the edge of glass is the glass's fringe: sash for windows, part of the blob otherwise.
const fringe = bfsDist((k) => comp[k] >= 0, (k) => isBlue(k) && !isGlass(k), THIN + 2);
const nearestComp = new Int32Array(N).fill(-1);
{ // propagate component ids into the fringe
  const order = []; for (let k = 0; k < N; k++) if (fringe[k] > 0) order.push(k);
  order.sort((a, b) => fringe[a] - fringe[b]);
  for (const k of order) {
    const x = k % W, y = (k / W) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const kk = (y + dy) * W + x + dx;
      const id = comp[kk] >= 0 ? comp[kk] : nearestComp[kk];
      if (id >= 0 && (fringe[kk] === fringe[k] - 1)) { nearestComp[k] = id; break; }
    }
  }
}

// Windows: BFS from glass into adjacent trim, up to SASH px -> accent. Then glass -> black.
const dist = new Int16Array(N).fill(-1);
let qh = 0, qt = 0; const q = new Int32Array(N);
for (let k = 0; k < N; k++) {
  const id = comp[k] >= 0 ? comp[k] : nearestComp[k];
  if (id >= 0 && comps[id].kind === 'window') { dist[k] = 0; q[qt++] = k; }
}
while (qh < qt) {
  const k = q[qh++], x = k % W, y = (k / W) | 0;
  if (dist[k] >= SASH) continue;
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    const xx = x + dx, yy = y + dy;
    if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
    const kk = yy * W + xx;
    // grow into trim, and across the thin dark outline next to the glass
    if (dist[kk] < 0 && (lab[kk] === TRIM || (lab[kk] === BLACK && comp[kk] < 0 && dist[k] < OUTLINE))) { dist[kk] = dist[k] + 1; q[qt++] = kk; }
  }
}
for (let k = 0; k < N; k++) {
  if (comp[k] >= 0) lab[k] = BLACK;                                   // all glass / blobs -> unpainted
  else if (nearestComp[k] >= 0) lab[k] = comps[nearestComp[k]].kind === 'window' ? ACCENT : BLACK;
  else if (dist[k] > 0) lab[k] = ACCENT;                              // sash + muntins
}
const kinds = comps.reduce((a, c) => ((a[c.kind] = (a[c.kind] || 0) + 1), a), {});
console.log('blue regions:', kinds);

// Resample to photo resolution (2x supersampled, majority label).
const out = new Uint8Array(PW * PH * 3);
for (let y = 0; y < PH; y++) for (let x = 0; x < PW; x++) {
  const votes = [0, 0, 0, 0];
  for (let s = 0; s < 4; s++) {
    const px = x + 0.25 + 0.5 * (s & 1), py = y + 0.25 + 0.5 * (s >> 1);
    const mx = Math.min(W - 1, Math.max(0, Math.floor(px * SX + TX))), my = Math.min(H - 1, Math.max(0, Math.floor(py * SY + TY)));
    votes[lab[my * W + mx]]++;
  }
  let l = 0; for (let c = 1; c < 4; c++) if (votes[c] > votes[l]) l = c;
  // Stair railing (black metal, leave unpainted) — photo coords, excluding the bay window.
  if (l === ACCENT && x >= 975 && x <= 1245 && y >= 725 && y <= 895 && !(x >= 1030 && x <= 1185 && y <= 772)) l = BLACK;
  out.set(COLORS[l], (y * PW + x) * 3);
}
writeBmp(path.join(tmp, 'o.bmp'), PW, PH, out);
sipsTo(path.join(tmp, 'o.bmp'), DST, 'png');
fs.rmSync(tmp, { recursive: true, force: true });
console.log('wrote', path.relative(ROOT, DST), `${PW}x${PH}`);
