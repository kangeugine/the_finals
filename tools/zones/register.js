// Find the similarity transform official px -> Ape Squad image px.
//   ape = s · R(θ) · (official - offC) + apeC   (returned as a 2×3 matrix too)
// Features are locally contrast-normalised luminance; the official map's red
// tint is removed per zone first so zone-to-zone tint steps don't look like edges.
// Search: coarse (4 rotations × log-spaced scales) at low res, then refine θ/s
// at higher res. Translation comes from the FFT correlation peak.

const { read } = require('./img');
const { spectrum, correlate } = require('./fft');

const COARSE_W = 224, FINE_W = 448;

function boxBlur(src, w, h, r) {
  const tmp = new Float64Array(w * h), out = new Float64Array(w * h);
  for (let y = 0; y < h; y++) {
    let s = 0;
    const o = y * w;
    for (let x = -r; x <= r; x++) s += src[o + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      tmp[o + x] = s / (2 * r + 1);
      s += src[o + Math.min(w - 1, x + r + 1)] - src[o + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let s = 0;
    for (let y = -r; y <= r; y++) s += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = s / (2 * r + 1);
      s += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
  return out;
}

// |∇| by central differences.
function gradMag(I, w, h) {
  const g = new Float64Array(w * h);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    g[i] = Math.hypot(I[i + 1] - I[i - 1], I[i + w] - I[i - w]);
  }
  return g;
}

// Local contrast normalisation with a validity mask (normalised convolution).
function lcn(I, V, w, h, r) {
  const IV = I.map((v, i) => v * V[i]);
  const I2V = I.map((v, i) => v * v * V[i]);
  const bV = boxBlur(V, w, h, r), bI = boxBlur(IV, w, h, r), bI2 = boxBlur(I2V, w, h, r);
  const out = new Float64Array(w * h);
  const sds = [];
  for (let i = 0; i < w * h; i++) {
    if (V[i] < 0.5 || bV[i] < 0.2) continue;
    const m = bI[i] / bV[i];
    const sd = Math.sqrt(Math.max(0, bI2[i] / bV[i] - m * m));
    sds.push(sd);
    out[i] = I[i] - m;
  }
  sds.sort((a, b) => a - b);
  const eps = (sds[sds.length >> 1] || 1) * 0.5; // damp flat areas (fog, background)
  for (let i = 0, k = 0; i < w * h; i++) {
    if (V[i] < 0.5 || bV[i] < 0.2) continue;
    const m = bI[i] / bV[i];
    const sd = Math.sqrt(Math.max(0, bI2[i] / bV[i] - m * m));
    out[i] /= Math.sqrt(sd * sd + eps * eps);
    k++;
  }
  return out;
}

// Official feature at `g` × full res: per-zone standardised luminance, masked to
// zone interiors (no labels, no border lines).
function officialFeature(im, owner, g, mode = 'texture') {
  if (mode === 'edges') return officialEdges(im, owner, g);
  if (mode === 'buildings') return officialBuildings(im, owner, g);
  const { w, h, data } = im;
  const N = w * h;
  const lum = new Float64Array(N);
  const M = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const r = data[i * 3], gg = data[i * 3 + 1], b = data[i * 3 + 2];
    lum[i] = r + gg + b;
    const lo = Math.min(r, gg, b), hi = Math.max(r, gg, b);
    const sat = (r - Math.max(gg, b)) / Math.max(r, 1);
    M[i] = owner[i] >= 0 && !(lo > 150 && hi - lo < 50) && sat > 0.3 ? 1 : 0;
  }
  // Erode: drop pixels near another zone / outside / text.
  const E = 3;
  const M2 = new Uint8Array(N);
  for (let y = E; y < h - E; y++) for (let x = E; x < w - E; x++) {
    const i = y * w + x;
    if (!M[i]) continue;
    const o = owner[i];
    let ok = true;
    for (const j of [i - E, i + E, i - E * w, i + E * w]) if (!M[j] || owner[j] !== o) ok = false;
    M2[i] = ok ? 1 : 0;
  }
  // Per-zone mean/std.
  const st = {};
  for (let i = 0; i < N; i++) if (M2[i]) {
    const s = (st[owner[i]] ??= { n: 0, s: 0, s2: 0 });
    s.n++; s.s += lum[i]; s.s2 += lum[i] * lum[i];
  }
  for (const s of Object.values(st)) {
    s.m = s.s / s.n;
    s.sd = Math.sqrt(Math.max(1e-6, s.s2 / s.n - s.m * s.m));
  }
  // Area-downsample to g.
  const ow = Math.round(w * g), oh = Math.round(h * g);
  const sumI = new Float64Array(ow * oh), sumM = new Float64Array(ow * oh), cnt = new Float64Array(ow * oh);
  for (let y = 0; y < h; y++) {
    const oy = Math.min(oh - 1, (y * g) | 0);
    for (let x = 0; x < w; x++) {
      const ox = Math.min(ow - 1, (x * g) | 0);
      const j = oy * ow + ox, i = y * w + x;
      cnt[j]++;
      if (M2[i]) {
        const s = st[owner[i]];
        sumI[j] += (lum[i] - s.m) / s.sd;
        sumM[j]++;
      }
    }
  }
  const I = new Float64Array(ow * oh), V = new Float64Array(ow * oh);
  for (let j = 0; j < ow * oh; j++) {
    V[j] = cnt[j] && sumM[j] / cnt[j] > 0.5 ? 1 : 0;
    I[j] = sumM[j] ? sumI[j] / sumM[j] : 0;
  }
  return { w: ow, h: oh, I: lcn(I, V, ow, oh, 4), V };
}

// Schematic official maps (no satellite underlay): use edges of the drawing
// itself — zone borders, block outlines, map outline. Label text is painted
// over with its zone's mean colour first.
function officialEdges(im, owner, g) {
  const { w, h, data } = im;
  const N = w * h;
  const lum = new Float64Array(N);
  const st = {};
  const isText = (i) => {
    const r = data[i * 3], gg = data[i * 3 + 1], b = data[i * 3 + 2];
    const lo = Math.min(r, gg, b), hi = Math.max(r, gg, b);
    return lo > 150 && hi - lo < 50;
  };
  for (let i = 0; i < N; i++) {
    lum[i] = data[i * 3] + data[i * 3 + 1] + data[i * 3 + 2];
    if (owner[i] >= 0 && !isText(i)) {
      const s = (st[owner[i]] ??= { n: 0, s: 0 });
      s.n++; s.s += lum[i];
    }
  }
  for (let i = 0; i < N; i++) if (owner[i] >= 0 && isText(i)) lum[i] = st[owner[i]] ? st[owner[i]].s / st[owner[i]].n : lum[i];
  // Ignore the title bar and footer (anything far from the zones).
  let y0 = h, y1 = 0;
  for (let i = 0; i < N; i++) if (owner[i] >= 0) { const y = (i / w) | 0; y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  const pad = Math.round(h * 0.02);
  const ow = Math.round(w * g), oh = Math.round(h * g);
  const sum = new Float64Array(ow * oh), cnt = new Float64Array(ow * oh);
  for (let y = 0; y < h; y++) {
    const oy = Math.min(oh - 1, (y * g) | 0);
    for (let x = 0; x < w; x++) {
      const j = oy * ow + Math.min(ow - 1, (x * g) | 0);
      sum[j] += lum[y * w + x]; cnt[j]++;
    }
  }
  const I = sum.map((v, j) => v / (cnt[j] || 1));
  const V = new Float64Array(ow * oh);
  for (let oy = 0; oy < oh; oy++) {
    const y = oy / g;
    if (y < y0 - pad || y > y1 + pad) continue;
    for (let ox = 0; ox < ow; ox++) V[oy * ow + ox] = 1;
  }
  return { w: ow, h: oh, I: lcn(gradMag(boxBlur(I, ow, oh, 1), ow, oh), V, ow, oh, 4), V };
}

// Building footprints: the official maps draw buildings as lighter shapes than
// their zone's tint. Matched against grey (low-saturation) roofs on the Ape side.
function officialBuildings(im, owner, g) {
  const { w, h, data } = im;
  const N = w * h;
  const lum = (i) => data[i * 3] + data[i * 3 + 1] + data[i * 3 + 2];
  const st = {};
  for (let i = 0; i < N; i += 7) if (owner[i] >= 0) (st[owner[i]] ??= []).push(lum(i));
  const med = {};
  for (const [k, a] of Object.entries(st)) med[k] = a.sort((x, y) => x - y)[a.length >> 1];
  const ow = Math.round(w * g), oh = Math.round(h * g);
  const sum = new Float64Array(ow * oh), cnt = new Float64Array(ow * oh);
  for (let y = 0; y < h; y++) {
    const oy = Math.min(oh - 1, (y * g) | 0);
    for (let x = 0; x < w; x++) {
      const i = y * w + x, j = oy * ow + Math.min(ow - 1, (x * g) | 0);
      cnt[j]++;
      if (owner[i] >= 0 && lum(i) - med[owner[i]] > 45) sum[j]++;
    }
  }
  const I = sum.map((v, j) => v / (cnt[j] || 1));
  const V = new Float64Array(ow * oh);
  for (let j = 0; j < ow * oh; j++) V[j] = 1;
  return { w: ow, h: oh, I: lcn(I, V, ow, oh, 6), V };
}

function apeFeature(file, width, mode = 'texture') {
  const full = read(file, 1);
  const f = width / full.w;
  const im = read(file, f);
  const N = im.w * im.h;
  const I = new Float64Array(N), V = new Float64Array(N).fill(1);
  for (let i = 0; i < N; i++) I[i] = im.data[i * 3] + im.data[i * 3 + 1] + im.data[i * 3 + 2];
  if (mode === 'buildings') {
    // Roof fraction per pixel, from a full-res pass (roofs are grey, mid-bright).
    const R = new Float64Array(N), C = new Float64Array(N);
    for (let y = 0; y < full.h; y++) {
      const oy = Math.min(im.h - 1, (y * f) | 0);
      for (let x = 0; x < full.w; x++) {
        const i = (y * full.w + x) * 3, j = oy * im.w + Math.min(im.w - 1, (x * f) | 0);
        const r = full.data[i], gg = full.data[i + 1], b = full.data[i + 2];
        const hi = Math.max(r, gg, b), lo = Math.min(r, gg, b), L = (r + gg + b) / 3;
        C[j]++;
        if (hi - lo < 35 && L > 75 && L < 215) R[j]++;
      }
    }
    for (let j = 0; j < N; j++) I[j] = R[j] / (C[j] || 1);
    return { w: im.w, h: im.h, f: im.w / full.w, fullW: full.w, fullH: full.h, I: lcn(I, V, im.w, im.h, 6) };
  }
  const F = mode === 'edges' ? gradMag(boxBlur(I, im.w, im.h, 1), im.w, im.h) : I;
  return { w: im.w, h: im.h, f: im.w / full.w, fullW: full.w, fullH: full.h, I: lcn(F, V, im.w, im.h, 4) };
}

// Rotate/scale the official feature (k = template px per feature px) into a P×P canvas.
function warp(O, theta, k, P) {
  const c = Math.cos(theta), s = Math.sin(theta);
  const hw = (O.w * k) / 2, hh = (O.h * k) / 2;
  const bw = Math.ceil(Math.abs(c) * hw + Math.abs(s) * hh), bh = Math.ceil(Math.abs(s) * hw + Math.abs(c) * hh);
  const tw = 2 * bw, th = 2 * bh;
  if (tw >= P || th >= P) return null;
  const T = new Float64Array(P * P), M = new Float64Array(P * P);
  let n = 0, e = 0;
  for (let qy = 0; qy < th; qy++) for (let qx = 0; qx < tw; qx++) {
    const dx = qx - bw, dy = qy - bh;
    // Inverse rotation, then scale back to feature px.
    const px = (c * dx + s * dy) / k + O.w / 2, py = (-s * dx + c * dy) / k + O.h / 2;
    const x0 = Math.floor(px), y0 = Math.floor(py);
    if (x0 < 0 || y0 < 0 || x0 >= O.w - 1 || y0 >= O.h - 1) continue;
    const fx = px - x0, fy = py - y0;
    const i = y0 * O.w + x0;
    const v = (O.V[i] * (1 - fx) + O.V[i + 1] * fx) * (1 - fy) + (O.V[i + O.w] * (1 - fx) + O.V[i + O.w + 1] * fx) * fy;
    if (v < 0.99) continue;
    const val = (O.I[i] * (1 - fx) + O.I[i + 1] * fx) * (1 - fy) + (O.I[i + O.w] * (1 - fx) + O.I[i + O.w + 1] * fx) * fy;
    T[qy * P + qx] = val;
    M[qy * P + qx] = 1;
    n++; e += val * val;
  }
  return { T, M, tw, th, bw, bh, n, norm: Math.sqrt(e) };
}

function makeTarget(A, P) {
  const a = new Float64Array(P * P), a2 = new Float64Array(P * P);
  for (let y = 0; y < A.h; y++) for (let x = 0; x < A.w; x++) {
    const v = A.I[y * A.w + x];
    a[y * P + x] = v;
    a2[y * P + x] = v * v;
  }
  return { P, FA: spectrum(a, P), FA2: spectrum(a2, P) };
}

// Best NCC over translations for one (θ, k). Returns template-centre position in target px.
// `win` = { cx, cy, r } limits the template centre to a disc (target px).
function score(O, A, tgt, theta, k, win = null) {
  const { P } = tgt;
  const t = warp(O, theta, k, P);
  if (!t || t.n < 200) return null;
  const C = correlate(tgt.FA[0], tgt.FA[1], t.T, P);
  const E = correlate(tgt.FA2[0], tgt.FA2[1], t.M, P);
  let best = { ncc: -Infinity };
  // Allow the template to hang over the target edge by up to 15% (more when
  // a window says where it is: some Ape Squad images crop the map).
  const over = win ? 0.4 : 0.15;
  const mx = Math.round(t.tw * over), my = Math.round(t.th * over);
  // (Template may also be larger than the target when the Ape Squad image crops the map.)
  let x0 = Math.min(0, A.w - t.tw) - mx, x1 = Math.max(0, A.w - t.tw) + mx;
  let y0 = Math.min(0, A.h - t.th) - my, y1 = Math.max(0, A.h - t.th) + my;
  if (win) {
    x0 = Math.max(x0, Math.floor(win.cx - win.r - t.bw)); x1 = Math.min(x1, Math.ceil(win.cx + win.r - t.bw));
    y0 = Math.max(y0, Math.floor(win.cy - win.r - t.bh)); y1 = Math.min(y1, Math.ceil(win.cy + win.r - t.bh));
  }
  for (let dy = y0; dy <= y1; dy++) for (let dx = x0; dx <= x1; dx++) {
    const i = ((dy + P) % P) * P + ((dx + P) % P);
    if (E[i] < 0.2 * t.n) continue;
    const ncc = C[i] / (t.norm * Math.sqrt(E[i]));
    if (ncc > best.ncc) best = { ncc, dx, dy, i };
  }
  if (!best.i && best.i !== 0) return null;
  // Sub-pixel peak (parabolic) on the raw correlation.
  const at = (dx, dy) => C[((dy + P) % P) * P + ((dx + P) % P)];
  const sub = (m, c0, p) => { const d = m - 2 * c0 + p; return d < 0 ? (0.5 * (m - p)) / d : 0; };
  const sx = sub(at(best.dx - 1, best.dy), at(best.dx, best.dy), at(best.dx + 1, best.dy));
  const sy = sub(at(best.dx, best.dy - 1), at(best.dx, best.dy), at(best.dx, best.dy + 1));
  return { ncc: best.ncc, theta, k, cx: best.dx + sx + t.bw, cy: best.dy + sy + t.bh };
}

// `align` (optional, from zones.config.json) narrows the search for maps the
// blind search gets wrong:
//   theta: degrees (searched ±4°; exactly, with lockTheta: true),
//   thetaStep: search every angle at this step instead (badly rotated images),
//   scale: number (±12%) or [min, max],
//   anchor: [[official u, v], [ape x, y]] — a matching point pair; the
//   translation is then searched only within `window` (fraction of ape width).
function register(im, owner, apeFile, { log = () => {}, mode = 'texture', align = {} } = {}) {
  const apeFull = read(apeFile, 1);
  let sMin, sMax;
  if (Array.isArray(align.scale)) [sMin, sMax] = align.scale;
  else if (align.scale) [sMin, sMax] = [align.scale / 1.12, align.scale * 1.12];
  else {
    // Official zone bbox bounds the plausible scale range.
    let x0 = im.w, y0 = im.h, x1 = 0, y1 = 0;
    for (let i = 0; i < im.w * im.h; i++) if (owner[i] >= 0) {
      const x = i % im.w, y = (i / im.w) | 0;
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
    sMax = (1.1 * Math.max(apeFull.w, apeFull.h)) / Math.max(x1 - x0, y1 - y0);
    sMin = sMax / 4;
  }
  const thetas = align.thetaStep
    ? Array.from({ length: Math.round(360 / align.thetaStep) }, (_, i) => i * align.thetaStep)
    : align.theta == null
    ? [0, 90, 180, 270]
    : align.lockTheta ? [align.theta] : [-4, -2, 0, 2, 4].map((d) => align.theta + d);
  const offC = [im.w / 2, im.h / 2];
  // Predicted template centre (ape full px) for a given θ/s, from the anchor.
  const predict = (theta, s) => {
    if (!align.anchor) return null;
    const [[u, v], [x, y]] = align.anchor;
    const c = Math.cos(theta), sn = Math.sin(theta);
    const du = offC[0] - u, dv = offC[1] - v;
    return [x + s * (c * du - sn * dv), y + s * (sn * du + c * dv)];
  };
  const winFor = (A, theta, s) => {
    const p = predict(theta, s);
    return p && { cx: p[0] * A.f, cy: p[1] * A.f, r: (align.window ?? 0.08) * A.w };
  };

  // --- coarse ---
  const A = apeFeature(apeFile, COARSE_W, mode);
  const sMid = Math.sqrt(sMin * sMax);
  const g = sMid * A.f; // official feature res so that k ≈ 1 mid-range
  const O = officialFeature(im, owner, g, mode);
  // Canvas must hold the target plus the largest (rotated) template.
  const pow2 = (n) => 2 ** Math.ceil(Math.log2(n));
  const canvas = (A, O, k) => pow2(Math.max(A.w, A.h) + Math.hypot(O.w, O.h) * k + 2);
  const tgt = makeTarget(A, canvas(A, O, (sMax * A.f) / g));
  const results = [];
  for (const deg of thetas) {
    const theta = (deg * Math.PI) / 180;
    let best = null;
    for (let s = sMin; s <= sMax * 1.0001; s *= 1.02) {
      const r = score(O, A, tgt, theta, (s * A.f) / g, winFor(A, theta, s));
      if (r && (!best || r.ncc > best.ncc)) best = { ...r, s };
    }
    if (best) results.push(best);
    if (!align.thetaStep) log(`  θ ${deg}°: ncc ${best?.ncc.toFixed(3)} at s ${best?.s.toFixed(3)}`);
  }
  results.sort((a, b) => b.ncc - a.ncc);
  if (align.thetaStep) for (const r of results.slice(0, 5)) log(`  θ ${((r.theta * 180) / Math.PI).toFixed(0)}°: ncc ${r.ncc.toFixed(3)} at s ${r.s.toFixed(3)}`);
  const best = results[0];

  // --- fine ---
  const A2 = apeFeature(apeFile, FINE_W, mode);
  const g2 = best.s * A2.f;
  const O2 = officialFeature(im, owner, g2, mode);
  const tgt2 = makeTarget(A2, canvas(A2, O2, 1.15));
  const at = (theta, s) => score(O2, A2, tgt2, theta, (s * A2.f) / g2, winFor(A2, theta, s));
  let cur = { ...at(best.theta, best.s), s: best.s };
  for (const [dTheta, dS] of [[0.5, 0.01], [0.2, 0.004], [0.08, 0.0015]]) {
    for (let pass = 0; pass < 2; pass++) {
      for (let k = -4; k <= 4 && !align.lockTheta; k++) {
        const r = at(cur.theta + (k * dTheta * Math.PI) / 180, cur.s);
        if (r && r.ncc > cur.ncc) cur = { ...r, s: cur.s };
      }
      for (let k = -4; k <= 4; k++) {
        const s = cur.s * (1 + k * dS);
        const r = at(cur.theta, s);
        if (r && r.ncc > cur.ncc) cur = { ...r, s };
      }
    }
  }
  log(`  fine: ncc ${cur.ncc.toFixed(3)} θ ${((cur.theta * 180) / Math.PI).toFixed(2)}° s ${cur.s.toFixed(4)}`);

  // Template centre (fine target px) ↔ official image centre.
  const apeC = [cur.cx / A2.f, cur.cy / A2.f];
  const c = Math.cos(cur.theta) * cur.s, sn = Math.sin(cur.theta) * cur.s;
  const matrix = [c, -sn, apeC[0] - c * offC[0] + sn * offC[1], sn, c, apeC[1] - sn * offC[0] - c * offC[1]];
  return {
    theta: (cur.theta * 180) / Math.PI, scale: cur.s, ncc: cur.ncc,
    runnerUp: results[1]?.ncc ?? null, matrix,
  };
}

module.exports = { register };
