'use strict';
// Reference photo (box under the formula circle): drop or pick a photo of any house, then drag the
// S / T / A pins onto its siding,
// trim and accent. Each pin samples the photo under it and sets that color via setColor() in app.js,
// which updates the color bar, the formula widget and the previews.
// The file never leaves the browser: it's read via an object URL and drawn to a canvas.

(() => {
  const MAX_BYTES = 30 * 1024 * 1024; // ignore absurdly large files
  const MAX_DIM = 1600;               // downscale big photos (plenty for sampling)
  const SAMPLE_R = 3;                 // average a (2r+1)² patch, in image px
  const KEYS = ['siding', 'trim', 'accent'];
  const LETTER = { siding: 'S', trim: 'T', accent: 'A' };
  const START = { siding: [0.3, 0.5], trim: [0.5, 0.5], accent: [0.7, 0.5] }; // fractions of W/H

  const host = document.getElementById('photoBox');
  const removeBtn = document.getElementById('removePhoto');
  const fileInput = document.getElementById('photoFile');
  const note = document.getElementById('photoNote');

  let ref = null; // { canvas, ctx, src (offscreen canvas), data (Uint8ClampedArray), W, H, pins }

  // ---- loading ----
  function loadFile(file) {
    note.textContent = '';
    if (!file || !/^image\/(png|jpeg|webp|gif|avif|bmp)$/.test(file.type)) { note.textContent = 'That isn’t a supported image.'; return; }
    if (file.size > MAX_BYTES) { note.textContent = 'That image is too large.'; return; }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); show(img); };
    img.onerror = () => { URL.revokeObjectURL(url); note.textContent = 'Couldn’t read that image.'; };
    img.src = url;
  }

  function show(img) {
    const k = Math.min(1, MAX_DIM / Math.max(img.naturalWidth, img.naturalHeight));
    const W = Math.max(1, Math.round(img.naturalWidth * k)), H = Math.max(1, Math.round(img.naturalHeight * k));
    const src = document.createElement('canvas');
    src.width = W; src.height = H;
    const sctx = src.getContext('2d', { willReadFrequently: true });
    sctx.drawImage(img, 0, 0, W, H);
    const data = sctx.getImageData(0, 0, W, H).data;

    if (!ref) {
      const canvas = document.createElement('canvas');
      canvas.setAttribute('aria-label', 'Reference photo: drag the S, T and A pins onto the siding, trim and accent. Scroll to zoom, drag to pan, double-click to reset.');
      host.appendChild(canvas);
      host.classList.add('has-photo');
      ref = { canvas, ctx: canvas.getContext('2d') };
      wirePins();
    }
    Object.assign(ref, { src, data, W, H, pins: {} });
    fitted = true;
    for (const key of KEYS) ref.pins[key] = [START[key][0] * W, START[key][1] * H];
    removeBtn.hidden = false;
    for (const key of KEYS) setColor(key, sample(...ref.pins[key]));
    resize();
  }

  function remove() {
    if (!ref) return;
    ref.canvas.remove();
    ref = null;
    host.classList.remove('has-photo');
    removeBtn.hidden = true;
    note.textContent = '';
  }

  // ---- sampling ----
  const toLin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const toHex2 = (l) => {
    const s = l <= 0.0031308 ? l * 12.92 : 1.055 * l ** (1 / 2.4) - 0.055;
    return Math.round(Math.min(1, Math.max(0, s)) * 255).toString(16).padStart(2, '0');
  };
  function sample(x, y) {
    const { data, W, H } = ref;
    const cx = Math.round(x), cy = Math.round(y);
    let r = 0, g = 0, b = 0, n = 0;
    for (let yy = cy - SAMPLE_R; yy <= cy + SAMPLE_R; yy++) for (let xx = cx - SAMPLE_R; xx <= cx + SAMPLE_R; xx++) {
      if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
      const i = (yy * W + xx) * 4;
      r += toLin(data[i]); g += toLin(data[i + 1]); b += toLin(data[i + 2]); n++;
    }
    return ('#' + toHex2(r / n) + toHex2(g / n) + toHex2(b / n)).toUpperCase();
  }

  // ---- view (zoom / pan) ----
  // The canvas fills the box; the photo is drawn with a view transform:
  //   screen = (ox, oy) + image * scale   (CSS px)
  const MAX_ZOOM = 12; // × the fit-to-box scale
  let view = { scale: 1, ox: 0, oy: 0 }, fitted = true, dpr = 1;
  const boxSize = () => [host.clientWidth, host.clientHeight];
  const fitScale = () => { const [cw, ch] = boxSize(); return Math.min(cw / ref.W, ch / ref.H); };
  function fit() {
    const [cw, ch] = boxSize(), s = fitScale();
    view = { scale: s, ox: (cw - ref.W * s) / 2, oy: (ch - ref.H * s) / 2 };
    fitted = true;
  }
  function resize() {
    if (!ref) return;
    const [cw, ch] = boxSize();
    dpr = window.devicePixelRatio || 1;
    ref.canvas.width = Math.max(1, Math.round(cw * dpr));
    ref.canvas.height = Math.max(1, Math.round(ch * dpr));
    if (fitted) fit();
    draw();
  }
  function zoomAt(mx, my, f) {
    const s0 = view.scale, fs = fitScale();
    const s = Math.min(fs * MAX_ZOOM, Math.max(fs, s0 * f));
    if (s === fs) { fit(); return; }
    view = { scale: s, ox: mx - ((mx - view.ox) * s) / s0, oy: my - ((my - view.oy) * s) / s0 };
    fitted = false;
  }

  // ---- drawing ----
  function draw() {
    if (!ref) return;
    const { ctx, src, canvas } = ref;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingEnabled = view.scale < 2; // crisp pixels when zoomed way in
    ctx.setTransform(dpr * view.scale, 0, 0, dpr * view.scale, dpr * view.ox, dpr * view.oy);
    ctx.drawImage(src, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // pins in screen px
    const r = 8;
    for (const key of KEYS) {
      const x = view.ox + ref.pins[key][0] * view.scale, y = view.oy + ref.pins[key][1] * view.scale;
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = state.colors[key]; ctx.fill();
      ctx.lineWidth = 2.5; ctx.strokeStyle = '#fff'; ctx.stroke();
      ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(0,0,0,0.7)';
      ctx.beginPath(); ctx.arc(x, y, r + 1.75, 0, Math.PI * 2); ctx.stroke();
      ctx.font = '700 11px system-ui, sans-serif';
      ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,0.75)'; ctx.fillStyle = '#fff';
      ctx.strokeText(LETTER[key], x + r + 3, y + 4); ctx.fillText(LETTER[key], x + r + 3, y + 4);
    }
  }

  // ---- pins, pan, zoom ----
  function wirePins() {
    const c = ref.canvas;
    const local = (e) => { const r = c.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    const toImg = (mx, my) => [(mx - view.ox) / view.scale, (my - view.oy) / view.scale];
    const pick = (mx, my) => {
      let best = null, bd = 16;
      for (const key of KEYS) {
        const d = Math.hypot(view.ox + ref.pins[key][0] * view.scale - mx, view.oy + ref.pins[key][1] * view.scale - my);
        if (d < bd) { bd = d; best = key; }
      }
      return best;
    };
    let drag = null;
    c.addEventListener('pointerdown', (e) => {
      const [mx, my] = local(e), key = pick(mx, my);
      drag = key ? { key } : { pan: [mx - view.ox, my - view.oy] };
      c.setPointerCapture(e.pointerId);
      c.style.cursor = key ? 'grabbing' : 'move';
      e.preventDefault();
    });
    c.addEventListener('pointermove', (e) => {
      const [mx, my] = local(e);
      if (!drag) { c.style.cursor = pick(mx, my) ? 'grab' : (fitted ? 'default' : 'move'); return; }
      if (drag.key) {
        const [x, y] = toImg(mx, my);
        ref.pins[drag.key] = [Math.min(ref.W - 1, Math.max(0, x)), Math.min(ref.H - 1, Math.max(0, y))];
        setColor(drag.key, sample(...ref.pins[drag.key]));
      } else if (!fitted) {
        view.ox = mx - drag.pan[0]; view.oy = my - drag.pan[1];
      }
      draw();
    });
    const end = () => { drag = null; c.style.cursor = ''; };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    // wheel / trackpad pinch zooms around the cursor; double-click resets
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const [mx, my] = local(e);
      zoomAt(mx, my, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)));
      draw();
    }, { passive: false });
    c.addEventListener('dblclick', () => { fit(); draw(); });
    new ResizeObserver(resize).observe(host);
  }

  // Keep pin fills in sync when colors change elsewhere (presets, formula, pickers).
  const prev = window.onColorsChanged;
  window.onColorsChanged = () => { if (prev) prev(); draw(); };

  // ---- UI: button, file input, drag & drop anywhere ----
  const browse = () => { if (!ref) fileInput.click(); }; // once a photo is shown, clicks are for the pins
  host.addEventListener('click', browse);
  host.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); browse(); } });
  fileInput.addEventListener('change', () => { loadFile(fileInput.files[0]); fileInput.value = ''; });
  removeBtn.addEventListener('click', remove);
  let depth = 0;
  const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
  document.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; depth++; document.body.classList.add('dropping'); });
  document.addEventListener('dragleave', (e) => { if (!hasFiles(e)) return; if (--depth <= 0) { depth = 0; document.body.classList.remove('dropping'); } });
  document.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  document.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    document.body.classList.remove('dropping');
    loadFile(e.dataTransfer.files[0]);
  });
})();

