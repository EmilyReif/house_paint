'use strict';
// "Formula" editor: a rotate line around a hue ring (with siding/trim/accent dots) around a
// lightness × chroma square for the selected dot. Works in OKLCH so equal lightness looks equally light across hues.
// The three colors in app.js `state.colors` stay the single source of truth:
//   - dragging here calls applyCombo(...)
//   - any other change (preset, hex, picker) calls window.onColorsChanged(), which re-reads them.

(() => {
  const KEYS = ['siding', 'trim', 'accent'];
  const LETTER = { siding: 'S', trim: 'T', accent: 'A' };
  const C_MAX = 0.125;         // chroma at the right edge of the square (half the old range: no super-saturated colors)
  const STEP = 15;             // arrow-key hue step (degrees)
  const FORMULAS = [           // [label, trim offset, accent offset] relative to siding hue
    ['Mono', 0, 0],
    ['Analog', 30, -30],
    ['Comp', 180, 180],    // trim + accent opposite the siding (e.g. blue siding, cream trim, gold accent)
    ['Split', 150, 210],
    ['Triad', 120, 240],
  ];

  // ---- OKLCH <-> sRGB (Björn Ottosson) ----
  const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const toGamma = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);
  function hexToLch(hex) {
    const n = parseInt(hex.slice(1), 16);
    const r = toLinear(((n >> 16) & 255) / 255), g = toLinear(((n >> 8) & 255) / 255), b = toLinear((n & 255) / 255);
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
    const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
    const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
    return { L, C: Math.hypot(A, B), h: ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360 };
  }
  function lchToLinear(L, C, h) {
    const a = C * Math.cos((h * Math.PI) / 180), b = C * Math.sin((h * Math.PI) / 180);
    const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
    return [
      4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
      -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
      -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
    ];
  }
  const inGamut = (rgb) => rgb.every((v) => v >= -1e-4 && v <= 1 + 1e-4);
  // Reduce chroma until the color fits in sRGB (keeps lightness + hue).
  function lchToRgb(L, C, h) {
    let rgb = lchToLinear(L, C, h);
    if (!inGamut(rgb)) {
      let lo = 0, hi = C;
      for (let i = 0; i < 14; i++) {
        const mid = (lo + hi) / 2;
        if (inGamut(lchToLinear(L, mid, h))) lo = mid; else hi = mid;
      }
      rgb = lchToLinear(L, lo, h);
    }
    return rgb.map((v) => Math.round(toGamma(Math.min(1, Math.max(0, v))) * 255));
  }
  const rgbToHex = (rgb) => '#' + rgb.map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();
  const lchToHex = (p) => rgbToHex(lchToRgb(p.L, p.C, p.h));

  // ---- model ----
  // Requested L/C/h per region (kept separately from the hex so grey trims keep a hue,
  // and out-of-gamut requests don't drift when clamped).
  const lch = {};
  let pushing = false;
  function readColors() {
    for (const k of KEYS) {
      const p = hexToLch(state.colors[k]);
      if (p.C < 0.01 && lch[k]) p.h = lch[k].h; // hue is meaningless for greys; keep the old one
      lch[k] = p;
    }
  }
  function push() {
    pushing = true;
    applyCombo(lchToHex(lch.siding), lchToHex(lch.trim), lchToHex(lch.accent));
    pushing = false;
    draw();
  }
  window.onColorsChanged = () => { if (!pushing) { readColors(); draw(); } };

  // ---- DOM ----
  // One canvas, from the outside in:
  //   rotate ring  - thin neutral line; drag anywhere on it to rotate all three hues
  //   hue ring     - colored; S/T/A dots sit on it. Click a dot to select it, drag it to change its hue
  //   square       - lightness (up) × saturation (right); all dots shown, the selected one is editable
//                  (click a faded dot to select it — the square then shows that dot's hue)
  // Layout: [Lightness presets]  [circle]  [Hue formulas]
  const host = document.getElementById('formula');
  const col = (cls, title) => {
    const d = document.createElement('div');
    d.className = 'formula-col ' + cls;
    const h = document.createElement('h3');
    h.textContent = title;
    d.appendChild(h);
    return d;
  };
  const lightCol = col('lightness', 'Lightness');
  const hueCol = col('hues', 'Hues');
  const cv = document.createElement('canvas');
  cv.tabIndex = 0;
  cv.setAttribute('aria-label', 'Color formula: outer line rotates all hues; click a dot on the color ring to select it; the square sets its lightness and saturation. Arrow keys rotate.');
  host.append(lightCol, cv, hueCol);

  for (const [label, dt, da] of FORMULAS) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'btn'; b.textContent = label;
    b.addEventListener('click', () => {
      lch.trim.h = (lch.siding.h + dt + 360) % 360;
      lch.accent.h = (lch.siding.h + da + 360) % 360;
      push();
    });
    hueCol.appendChild(b);
  }

  // Lightness presets per region (OKLCH L); chroma + hue are kept.
  const LEVELS = [['light', 0.9], ['med', 0.63], ['dark', 0.36]];
  const levelOf = (L) => (L >= 0.77 ? 'light' : L >= 0.5 ? 'med' : 'dark');
  const levelBtns = {};
  for (const k of KEYS) {
    const name = document.createElement('div');
    name.className = 'lvl-name';
    name.textContent = k[0].toUpperCase() + k.slice(1);
    const row = document.createElement('div');
    row.className = 'lvl-row';
    levelBtns[k] = {};
    for (const [label, L] of LEVELS) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'btn'; b.textContent = label;
      b.setAttribute('aria-label', `${k} ${label}`);
      b.addEventListener('click', () => { lch[k].L = L; selected = k; push(); });
      row.appendChild(b);
      levelBtns[k][label] = b;
    }
    lightCol.append(name, row);
  }
  function markLevels() {
    for (const k of KEYS) {
      const cur = levelOf(lch[k].L);
      for (const [label] of LEVELS) levelBtns[k][label].classList.toggle('on', label === cur);
    }
  }

  let selected = 'siding';
  let size = 0, dpr = 1, ringBg = null;
  const ROT_GAP = 20, HUE_W = 12, PAD = 6; // gap keeps the rotate line clear of the hue dots
  const geo = () => {
    const c = size / 2;
    const rRot = c - PAD;                          // rotate line
    const rHue = rRot - ROT_GAP - HUE_W / 2;       // center of color ring
    const half = (rHue - HUE_W / 2 - 8) / Math.SQRT2; // inscribed square half-side
    return { c, rRot, rHue, sq: { x: c - half, y: c - half, s: half * 2 } };
  };
  const SIZE = 280; // circle size (CSS px)
  function layout() {
    size = SIZE;
    dpr = window.devicePixelRatio || 1;
    cv.style.width = cv.style.height = size + 'px';
    cv.width = cv.height = Math.round(size * dpr);
    ringBg = null;
    draw();
  }

  const huePos = (h, r) => {
    const { c } = geo();
    return [c + r * Math.sin((h * Math.PI) / 180), c - r * Math.cos((h * Math.PI) / 180)];
  };
  const sqPos = (p) => {
    const { sq } = geo();
    return [sq.x + (Math.min(p.C, C_MAX) / C_MAX) * sq.s, sq.y + (1 - p.L) * sq.s];
  };

  function draw() {
    if (!size || !lch.siding) return;
    markLevels();
    const ctx = cv.getContext('2d');
    const { c, rRot, rHue, sq } = geo();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cv.width, cv.height);

    // square background at the selected dot's hue (low-res, scaled up)
    const N = 40, img = new ImageData(N, N), hue = lch[selected].h;
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      img.data.set([...lchToRgb(1 - (y + 0.5) / N, ((x + 0.5) / N) * C_MAX, hue), 255], (y * N + x) * 4);
    }
    const tmp = document.createElement('canvas');
    tmp.width = tmp.height = N;
    tmp.getContext('2d').putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(tmp, sq.x * dpr, sq.y * dpr, sq.s * dpr, sq.s * dpr);

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // rotate line
    ctx.strokeStyle = rotHover || rotDrag ? '#8a9097' : '#4a4f55';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(c, c, rRot, 0, Math.PI * 2); ctx.stroke();
    // color ring (cached)
    if (!ringBg) {
      ringBg = document.createElement('canvas');
      ringBg.width = ringBg.height = cv.width;
      const b = ringBg.getContext('2d');
      b.setTransform(dpr, 0, 0, dpr, 0, 0);
      b.lineWidth = HUE_W;
      for (let h = 0; h < 360; h += 2) {
        const a0 = ((h - 90 - 1.5) * Math.PI) / 180, a1 = ((h - 90 + 1.5) * Math.PI) / 180;
        b.strokeStyle = rgbToHex(lchToRgb(0.75, 0.13, h));
        b.beginPath(); b.arc(c, c, rHue, a0, a1); b.stroke();
      }
    }
    ctx.drawImage(ringBg, 0, 0, size, size);
    // dots on the hue ring (selected one drawn last / larger)
    for (const k of KEYS.filter((k) => k !== selected).concat(selected)) {
      dot(ctx, ...huePos(lch[k].h, rHue), k, k === selected);
    }
    // all three in the square: others faded, selected on top
    for (const k of KEYS) if (k !== selected) dot(ctx, ...sqPos(lch[k]), k, false, true);
    dot(ctx, ...sqPos(lch[selected]), selected, true);
  }

  function dot(ctx, x, y, k, isSel, faded = false) {
    const r = isSel ? 7 : 5;
    ctx.save();
    if (faded) ctx.globalAlpha = 0.55;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = state.colors[k]; ctx.fill();
    ctx.lineWidth = isSel ? 2.5 : 1.5; ctx.strokeStyle = '#fff'; ctx.stroke();
    ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.beginPath(); ctx.arc(x, y, r + 1.5, 0, Math.PI * 2); ctx.stroke();
    ctx.font = `${isSel ? 700 : 500} 10px system-ui, sans-serif`;
    ctx.fillStyle = '#fff'; ctx.strokeStyle = 'rgba(0,0,0,0.7)'; ctx.lineWidth = 3;
    ctx.strokeText(LETTER[k], x + r + 3, y + 3.5); ctx.fillText(LETTER[k], x + r + 3, y + 3.5);
    ctx.restore();
  }

  // ---- interaction ----
  const local = (e) => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  const angleAt = (x, y) => { const { c } = geo(); return ((Math.atan2(x - c, -(y - c)) * 180) / Math.PI + 360) % 360; };
  function rotate(d) {
    for (const k of KEYS) lch[k].h = (lch[k].h + d + 360) % 360;
    push();
  }
  function setLC(x, y) {
    const { sq } = geo();
    lch[selected].L = Math.min(1, Math.max(0, 1 - (y - sq.y) / sq.s));
    lch[selected].C = Math.min(1, Math.max(0, (x - sq.x) / sq.s)) * C_MAX;
    push();
  }
  // what's under the pointer: a hue dot, the square, or the rotate line
  function hit(x, y) {
    const { c, rRot, rHue, sq } = geo();
    let best = null, bd = 11;
    for (const k of KEYS) {
      const [px, py] = huePos(lch[k].h, rHue), d = Math.hypot(px - x, py - y);
      if (d < bd) { bd = d; best = k; }
    }
    if (best) return { type: 'dot', key: best };
    // a faded (unselected) dot in the square: select it (unless the selected dot is right there too)
    let sqBest = null, sd = 9;
    for (const k of KEYS) {
      const [px, py] = sqPos(lch[k]), d = Math.hypot(px - x, py - y);
      if (d < sd || (d <= sd && k === selected)) { sd = d; sqBest = k; }
    }
    if (sqBest && sqBest !== selected) return { type: 'sqdot', key: sqBest };
    if (x >= sq.x && x <= sq.x + sq.s && y >= sq.y && y <= sq.y + sq.s) return { type: 'square' };
    const r = Math.hypot(x - c, y - c);
    if (r >= rRot - 8 && r <= rRot + PAD + 2) return { type: 'rotate' }; // generous outward, none toward the ring
    return null;
  }

  let drag = null, rotHover = false, rotDrag = false;
  cv.addEventListener('pointerdown', (e) => {
    const [x, y] = local(e), t = hit(x, y);
    if (!t) return;
    cv.setPointerCapture(e.pointerId);
    e.preventDefault();
    if (t.type === 'dot') { selected = t.key; drag = t; draw(); }
    else if (t.type === 'sqdot') { selected = t.key; drag = { type: 'square' }; draw(); }
    else if (t.type === 'square') { drag = t; setLC(x, y); }
    else { drag = { type: 'rotate', last: angleAt(x, y) }; rotDrag = true; draw(); }
  });
  cv.addEventListener('pointermove', (e) => {
    const [x, y] = local(e);
    if (!drag) {
      const t = hit(x, y), over = t && t.type === 'rotate';
      cv.style.cursor = t ? (over ? 'grab' : 'pointer') : 'default';
      if (over !== rotHover) { rotHover = over; draw(); }
      return;
    }
    if (drag.type === 'dot') { lch[drag.key].h = angleAt(x, y); push(); }
    else if (drag.type === 'square') setLC(x, y);
    else {
      const a = angleAt(x, y);
      let d = a - drag.last;
      if (d > 180) d -= 360; else if (d < -180) d += 360;
      drag.last = a;
      rotate(d);
    }
  });
  const end = () => { drag = null; if (rotDrag) { rotDrag = false; draw(); } };
  cv.addEventListener('pointerup', end);
  cv.addEventListener('pointercancel', end);
  cv.addEventListener('pointerleave', () => { if (!drag && rotHover) { rotHover = false; draw(); } });
  cv.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { rotate(-STEP); e.preventDefault(); }
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { rotate(STEP); e.preventDefault(); }
  });

  readColors();
  new ResizeObserver(layout).observe(host);
  layout();
})();
