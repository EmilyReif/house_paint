// Cleans up images/mask_original.jpeg -> images/mask.png.
// Usage (macOS, no deps): node tools/edit_mask.js
// Uses `sips` to decode/encode; all geometry below is in *photo* pixel coords
// (images/house.jpeg, 1024x604) and is mapped into mask coords via MASK_CROP.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'images', 'mask_original.jpeg');
const DST = path.join(ROOT, 'images', 'mask.png');
const PHOTO_W = 1024, PHOTO_H = 604;
// Rough global fit of the (wider) original mask onto the photo, in original-mask px.
// Local residual misalignment is fixed by tools/mask_warp.json (see bottom).
const MASK_CROP = { x: 49.5, y: 0, w: 2660, h: 1528 };

// ---- BMP io (24-bit) ----
function readBmp(p) {
  const b = fs.readFileSync(p);
  const off = b.readUInt32LE(10), w = b.readInt32LE(18), hRaw = b.readInt32LE(22);
  const h = Math.abs(hRaw), topDown = hRaw < 0, stride = Math.ceil((w * 3) / 4) * 4;
  const px = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    const row = off + (topDown ? y : h - 1 - y) * stride;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3, j = row + x * 3;
      px[i] = b[j + 2]; px[i + 1] = b[j + 1]; px[i + 2] = b[j];
    }
  }
  return { w, h, px };
}
function writeBmp(p, w, h, px) {
  const stride = Math.ceil((w * 3) / 4) * 4, b = Buffer.alloc(54 + stride * h);
  b.write('BM'); b.writeUInt32LE(b.length, 2); b.writeUInt32LE(54, 10); b.writeUInt32LE(40, 14);
  b.writeInt32LE(w, 18); b.writeInt32LE(-h, 22); b.writeUInt16LE(1, 26); b.writeUInt16LE(24, 28);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 3, j = 54 + y * stride + x * 3;
    b[j] = px[i + 2]; b[j + 1] = px[i + 1]; b[j + 2] = px[i];
  }
  fs.writeFileSync(p, b);
}

// ---- labels ----
const BLACK = 0, SIDING = 1, TRIM = 2, ACCENT = 3;
const COLORS = [[0, 0, 0], [255, 0, 0], [0, 255, 0], [0, 0, 255]];

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mask-'));
const inBmp = path.join(tmp, 'in.bmp'), outBmp = path.join(tmp, 'out.bmp');
execFileSync('sips', ['-s', 'format', 'bmp', SRC, '--out', inBmp], { stdio: 'ignore' });
const M = readBmp(inBmp);
const W = M.w, H = M.h;

// Quantize to 4 pure labels (removes JPEG noise).
const lab = new Uint8Array(W * H);
for (let i = 0; i < W * H; i++) {
  const r = M.px[i * 3], g = M.px[i * 3 + 1], b = M.px[i * 3 + 2];
  const mx = Math.max(r, g, b);
  lab[i] = mx < 100 ? BLACK : mx === r ? SIDING : mx === g ? TRIM : ACCENT;
}

const sx = MASK_CROP.w / PHOTO_W, sy = MASK_CROP.h / PHOTO_H;
const toMask = ([x0, y0, x1, y1]) => [
  Math.max(0, Math.round(MASK_CROP.x + x0 * sx)), Math.max(0, Math.round(MASK_CROP.y + y0 * sy)),
  Math.min(W, Math.round(MASK_CROP.x + x1 * sx)), Math.min(H, Math.round(MASK_CROP.y + y1 * sy)),
];
const S = (sx + sy) / 2; // mask px per photo px

function recolor(rect, from, to) {
  const [x0, y0, x1, y1] = toMask(rect);
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (lab[y * W + x] === from) lab[y * W + x] = to;
}

// Rebuild windows inside `rect`: every non-trim/non-siding pixel is glass+sash.
// Sash = band of width `frame` (photo px) along the glass edge -> ACCENT; the rest -> BLACK.
// Optional horizontal bars at photo y values (clipped to the glass).
function rebuildWindow(rect, frame, bars = []) {
  const [x0, y0, x1, y1] = toMask(rect);
  const w = x1 - x0, h = y1 - y0;
  const inR = new Uint8Array(w * h), dist = new Int32Array(w * h).fill(-1);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const l = lab[(y + y0) * W + x + x0];
    inR[y * w + x] = l === BLACK || l === ACCENT ? 1 : 0;
  }
  // Multi-source BFS (8-connected) from pixels touching non-window pixels.
  const q = new Int32Array(w * h); let qh = 0, qt = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!inR[y * w + x]) continue;
    let edge = false;
    for (let dy = -1; dy <= 1 && !edge; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx >= 0 && yy >= 0 && xx < w && yy < h && !inR[yy * w + xx]) { edge = true; break; }
    }
    if (edge) { dist[y * w + x] = 0; q[qt++] = y * w + x; }
  }
  while (qh < qt) {
    const k = q[qh++], x = k % w, y = (k / w) | 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
      const kk = yy * w + xx;
      if (inR[kk] && dist[kk] < 0) { dist[kk] = dist[k] + 1; q[qt++] = kk; }
    }
  }
  const fpx = frame * S;
  const barRows = bars.map(([py, t]) => [Math.round(MASK_CROP.y + py * sy) - y0, (t * S) / 2]);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const k = y * w + x;
    if (!inR[k]) continue;
    let l = dist[k] < fpx ? ACCENT : BLACK;
    for (const [by, half] of barRows) if (Math.abs(y - by) <= half) l = ACCENT;
    lab[(y + y0) * W + x + x0] = l;
  }
}

// 1) Upstairs window: no muntins, just a thin sash frame around each sash.
rebuildWindow([463, 68, 611, 184], 3);

// 2) Bay windows: thin sash frame + a single transom bar near the top (like the left one).
rebuildWindow([609, 267, 685, 397], 3.5, [[303, 3.5]]);
rebuildWindow([689, 265, 800, 394], 3.5, [[301, 3.5]]);
rebuildWindow([804, 267, 872, 397], 3.5, [[303, 3.5]]);

// 3) Porch swing (frame + cushion) -> unpainted.
recolor([288, 318, 445, 416], ACCENT, BLACK);

// 4) Stray blob in the bushes below the porch.
recolor([285, 450, 346, 492], ACCENT, BLACK);

// ---- Bake alignment: output at 2x photo resolution, already registered to the photo. ----
// tools/mask_warp.json holds a smooth per-region displacement field (photo px) on a coarse grid:
// output pixel at photo position p takes the mask label at MASK_CROP(p + d(p)).
const warpPath = path.join(__dirname, 'mask_warp.json');
const warp = fs.existsSync(warpPath) ? JSON.parse(fs.readFileSync(warpPath, 'utf8')) : null;
function disp(px, py) {
  if (!warp) return [0, 0];
  const gx = Math.min(warp.cols - 1.001, Math.max(0, px / warp.step));
  const gy = Math.min(warp.rows - 1.001, Math.max(0, py / warp.step));
  const i = Math.floor(gx), j = Math.floor(gy), fx = gx - i, fy = gy - j;
  const at = (a, ii, jj) => a[jj * warp.cols + ii];
  const bil = (a) => (at(a, i, j) * (1 - fx) + at(a, i + 1, j) * fx) * (1 - fy) + (at(a, i, j + 1) * (1 - fx) + at(a, i + 1, j + 1) * fx) * fy;
  return [bil(warp.dx), bil(warp.dy)];
}
// Post-alignment fixes, in photo coords (measured directly on images/house.jpeg).
const inBox = (px, py, [x0, y0, x1, y1]) => px >= x0 && px <= x1 && py >= y0 && py <= y1;
// Window transom bars (they slant with perspective): [x0, y0, x1, y1, thickness]
const BARS = [
  [611, 310.5, 684, 301.5, 2.5], // bay left
  [690, 299.5, 799, 299.5, 2.5], // bay middle
  [806, 301.5, 870, 311.5, 2.5], // bay right
];
function onBar(px, py) {
  for (const [x0, y0, x1, y1, t] of BARS) {
    if (px < x0 || px > x1) continue;
    const yy = y0 + ((y1 - y0) * (px - x0)) / (x1 - x0);
    if (Math.abs(py - yy) <= t / 2) return true;
  }
  return false;
}
function postFix(px, py, l) {
  if (l === ACCENT) {
    if (inBox(px, py, [233, 350, 284, 412])) return BLACK;  // glass terrarium on the porch
    if (inBox(px, py, [572, 348, 606, 382])) return TRIM;   // white bracket at the column
    if (inBox(px, py, [400, 430, 620, 604])) return BLACK;  // stairs
    if (inBox(px, py, [436, 380, 462, 430])) return BLACK;  // stair railing top
  }
  if (l === BLACK && onBar(px, py)) return ACCENT;
  return l;
}

const UP = 2, OW = PHOTO_W * UP, OH = PHOTO_H * UP;
const out = new Uint8Array(OW * OH * 3);
for (let y = 0; y < OH; y++) for (let x = 0; x < OW; x++) {
  const px = (x + 0.5) / UP, py = (y + 0.5) / UP;
  const [ddx, ddy] = disp(px, py);
  const mx = Math.min(W - 1, Math.max(0, Math.floor(MASK_CROP.x + (px + ddx) * sx)));
  const my = Math.min(H - 1, Math.max(0, Math.floor(MASK_CROP.y + (py + ddy) * sy)));
  out.set(COLORS[postFix(px, py, lab[my * W + mx])], (y * OW + x) * 3);
}
writeBmp(outBmp, OW, OH, out);
execFileSync('sips', ['-s', 'format', 'png', outBmp, '--out', DST], { stdio: 'ignore' });
fs.rmSync(tmp, { recursive: true, force: true });
console.log('wrote', path.relative(ROOT, DST));
