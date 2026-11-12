// Build zone overlays for the map tool from the official overview maps.
//   node tools/zones/build.js            # reuse cached transforms where present
//   node tools/zones/build.js --register # re-run registration for every map
//   node tools/zones/build.js "Bernal.webp" ...   # only these maps
// For each map in zones.config.json: segment the official map's zones, find the
// official -> Ape Squad transform, and write to app/data/map-data.json:
//   maps[id].zones = [{ name, label: {x, y}, polygons: [[[x, y], ...], ...] }]  (Ape Squad image px)
//   maps[id].rotation = nearest 90° to north-up, northLocked = true
// Transforms are cached in transforms.json (committed) because registration is slow.
// A map with `drawn` outlines (from dots.js, optionally hand-edited; a zone may
// list several rings, inner ones being holes) uses those instead: no
// segmentation, and its rotation is left as it is.

const fs = require('fs');
const path = require('path');
const { segment, polygons } = require('./segment');
const { register } = require('./register');
const { fitTps } = require('./tps');

const ROOT = path.join(__dirname, '..', '..');
const CONFIG = require('./zones.config.json');
const TRANSFORMS = path.join(__dirname, 'transforms.json');
const DATA = path.join(ROOT, 'app', 'data', 'map-data.json');

const args = process.argv.slice(2);
const reRegister = args.includes('--register');
const only = args.filter((a) => !a.startsWith('--'));

const transforms = fs.existsSync(TRANSFORMS) ? JSON.parse(fs.readFileSync(TRANSFORMS, 'utf8')) : {};
const data = JSON.parse(fs.readFileSync(DATA, 'utf8'));

const normalizeAngle = (deg) => {
  let a = ((((deg + 180) % 360) + 360) % 360) - 180;
  if (a === -180) a = 180;
  return Math.round(a * 10) / 10;
};

for (const [id, cfg] of Object.entries(CONFIG)) {
  if (id === '_doc' || (only.length && !only.includes(id))) continue;
  if (cfg.align?.skip) {
    console.log(`${id}: skipped (${cfg.align.skip})`);
    continue;
  }
  const t0 = Date.now();
  if (cfg.drawn) {
    const m = (data.maps[id] ??= { rotation: 0, northLocked: false, gridSpacing: 'auto', pois: [] });
    // A zone is one outline [[x, y], ...] or several rings [outline, hole, ...].
    const rings = (p) => (Array.isArray(p[0][0]) ? p : [p]);
    m.zones = Object.entries(cfg.drawn).map(([name, p]) => ({ name, label: interiorPoint(rings(p)), polygons: rings(p) }));
    console.log(`${id}: ${m.zones.length} hand-drawn zones`);
    continue;
  }
  const { im, owner, names } = segment(path.join(ROOT, 'maps', 'official', cfg.official), cfg.zones);

  let tf = transforms[id];
  if (cfg.align?.matrix) {
    // Hand-corrected transform (official px -> Ape px); never re-registered.
    const [a, b, , c] = cfg.align.matrix;
    tf = { theta: (Math.atan2(c, a) * 180) / Math.PI, scale: Math.hypot(a, c), ncc: NaN, matrix: cfg.align.matrix };
    transforms[id] = { ...tf, ncc: null, note: 'from zones.config.json align.matrix (manual fix)' };
  } else if (!tf || reRegister) {
    tf = register(im, owner, path.join(ROOT, 'maps', 'ape_squad_map', id), {
      mode: cfg.align?.mode || 'texture',
      align: cfg.align || {},
    });
    transforms[id] = { theta: +tf.theta.toFixed(3), scale: +tf.scale.toFixed(5), ncc: +tf.ncc.toFixed(3), matrix: tf.matrix.map((v) => +v.toFixed(5)) };
    fs.writeFileSync(TRANSFORMS, JSON.stringify(transforms, null, 2) + '\n');
  }
  const [a, b, tx, c, d, ty] = tf.matrix;
  // Optional hand correction: piecewise-linear remap of each image axis through
  // [from, to] control pairs (keeps axis-aligned edges straight).
  // Outside the first/last pair it's a plain shift, so unmarked areas keep their size.
  const pwl = (pairs) => (x) => {
    if (!pairs?.length) return x;
    const [f0, t0] = pairs[0], [fn, tn] = pairs[pairs.length - 1];
    if (x <= f0) return x + t0 - f0;
    if (x >= fn) return x + tn - fn;
    const i = pairs.findIndex(([p]) => p > x);
    const [[x0, y0], [x1, y1]] = [pairs[i - 1], pairs[i]];
    return y0 + ((x - x0) * (y1 - y0)) / (x1 - x0);
  };
  const wu = pwl(cfg.align?.warp?.u), wv = pwl(cfg.align?.warp?.v);
  const T = ([u, v]) => [Math.round(wu(a * u + b * v + tx)), Math.round(wv(c * u + d * v + ty))];

  const k = im.w / 2048;
  // Optional per-zone hand fixes (fix-zones.js), applied in order, in Ape px:
  // { u: [s, t], v: [s, t] } per-axis scale + shift, or { tps: { src, dst } } smooth warp.
  const zoneFix = (name) => {
    const f = cfg.align?.zoneFix?.[name];
    const steps = (Array.isArray(f) ? f : f ? [f] : []).map((st) =>
      st.tps ? fitTps(st.tps.src, st.tps.dst) : ([u, v]) => [st.u[0] * u + st.u[1], st.v[0] * v + st.v[1]]);
    return (q) => steps.reduce((p, step) => step(p), q).map(Math.round);
  };
  const zones = names.map((name, i) => {
    const F = zoneFix(name);
    return {
      name,
      label: Object.fromEntries(['x', 'y'].map((key, j) => [key, F(T(cfg.zones[name][0]))[j]])),
      polygons: polygons(im.w, im.h, owner, i, { minArea: 400 * k * k, epsilon: 3 * k }).map((p) => p.map((q) => F(T(q)))),
    };
  });

  const m = (data.maps[id] ??= { rotation: 0, northLocked: false, gridSpacing: 'auto', pois: [] });
  // Only ever rotate the Ape Squad image by multiples of 90°. A few images are
  // themselves tilted (Monaco, Fangwai City); their zones keep the true angle.
  // Exception: align.freeRotation (Kyoto's image is far off any 90° step).
  const north = -tf.theta;
  m.rotation = normalizeAngle(cfg.align?.freeRotation ? north : Math.round(north / 90) * 90);
  m.northLocked = true;
  m.zones = zones;
  const pts = zones.reduce((n, z) => n + z.polygons.reduce((s, p) => s + p.length, 0), 0);
  console.log(`${id}: ${zones.length} zones, ${pts} points, rotation ${m.rotation}°, ncc ${Number.isNaN(tf.ncc) ? 'manual' : tf.ncc.toFixed?.(3) ?? tf.ncc} (${Date.now() - t0} ms)`);
}

// Label spot for a drawn zone: the inside point farthest from its edges, so it
// sits in the middle even for curved or L-shaped zones. `rings` = outline +
// holes, inside by the even-odd rule (as the app fills them).
function interiorPoint(rings) {
  const all = rings.flat();
  const xs = all.map((p) => p[0]), ys = all.map((p) => p[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const inside = (x, y) => {
    let c = false;
    for (const poly of rings) for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i], [xj, yj] = poly[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
    }
    return c;
  };
  const edgeDist = (x, y) => Math.min(...rings.flatMap((poly) => poly.map(([ax, ay], i) => {
    const [bx, by] = poly[(i + 1) % poly.length];
    const t = Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2 || 1)));
    return Math.hypot(x - ax - t * (bx - ax), y - ay - t * (by - ay));
  })));
  let best = { x: Math.round((x0 + x1) / 2), y: Math.round((y0 + y1) / 2), d: -1 };
  const N = 60;
  for (let i = 0; i <= N; i++) for (let j = 0; j <= N; j++) {
    const x = x0 + ((x1 - x0) * i) / N, y = y0 + ((y1 - y0) * j) / N;
    if (!inside(x, y)) continue;
    const d = edgeDist(x, y);
    if (d > best.d) best = { x: Math.round(x), y: Math.round(y), d };
  }
  return { x: best.x, y: best.y };
}

fs.writeFileSync(DATA, JSON.stringify(data, null, 2));
console.log('Wrote ' + path.relative(ROOT, DATA));
