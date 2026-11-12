// Zone outlines from hand-drawn dots. Draw coloured dots around each zone on a
// copy of the Ape Squad map (same size; may be rotated 180°, e.g. drawn on the
// north-up view), one colour per zone. This diffs it against the plain map,
// groups the dots by colour, joins each group into a polygon (shortest closed
// path through its dots) and saves them to zones.config.json as `drawn`, which
// build.js then uses for that map instead of segmenting the official map.
//   node dots.js "<map id>" <drawn image> [<plain image>]
// The plain image defaults to maps/ape_squad_map/original/<map name>.png. Each
// colour is named after the existing zone whose label falls inside it.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { read } = require('./img');

const ROOT = path.join(__dirname, '..', '..');
const DIFF = 90;     // min |Δr|+|Δg|+|Δb| for a dot pixel
const MIN_DOT = 50;  // px; smaller specks are compression noise
const HUE_TOL = 15;  // degrees; dots within this of a group's hue share a zone

const [id, drawnFile, plainArg] = process.argv.slice(2);
if (!id || !drawnFile) {
  console.error('usage: node dots.js "<map id>" <drawn image> [<plain image>]');
  process.exit(1);
}
const plainFile = plainArg || path.join(ROOT, 'maps', 'ape_squad_map', 'original', path.parse(id).name + '.png');
const plain = read(plainFile);
const drawn = read(drawnFile);
const { w, h } = plain;
if (drawn.w !== w || drawn.h !== h) throw new Error(`size mismatch: ${drawn.w}×${drawn.h} vs ${w}×${h}`);

const diff = (i, j) =>
  Math.abs(plain.data[i] - drawn.data[j]) + Math.abs(plain.data[i + 1] - drawn.data[j + 1]) + Math.abs(plain.data[i + 2] - drawn.data[j + 2]);
// Drawn pixel index for plain pixel (x, y), as-is or rotated 180°.
const at = (flip) => (x, y) => (flip ? (h - 1 - y) * w + (w - 1 - x) : y * w + x) * 3;

// Orientation: whichever leaves fewer changed pixels (sampled).
const changed = (map) => {
  let n = 0;
  for (let y = 0; y < h; y += 4) for (let x = 0; x < w; x += 4) if (diff((y * w + x) * 3, map(x, y)) > DIFF) n++;
  return n;
};
const flip = changed(at(true)) < changed(at(false));
const src = at(flip);

// Dots = connected blobs of changed pixels; keep centroid + mean colour.
const mask = new Uint8Array(w * h);
for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (diff((y * w + x) * 3, src(x, y)) > DIFF) mask[y * w + x] = 1;
const dots = [];
const stack = [];
for (let p = 0; p < w * h; p++) {
  if (mask[p] !== 1) continue;
  const c = { n: 0, x: 0, y: 0, rgb: [0, 0, 0] };
  mask[p] = 2;
  stack.push(p);
  while (stack.length) {
    const q = stack.pop();
    const x = q % w, y = (q / w) | 0, j = src(x, y);
    c.n++;
    c.x += x;
    c.y += y;
    for (let k = 0; k < 3; k++) c.rgb[k] += drawn.data[j + k];
    for (const nq of [x > 0 && q - 1, x < w - 1 && q + 1, q - w, q + w]) {
      if (nq !== false && nq >= 0 && nq < w * h && mask[nq] === 1) (mask[nq] = 2), stack.push(nq);
    }
  }
  if (c.n >= MIN_DOT) dots.push({ x: Math.round(c.x / c.n), y: Math.round(c.y / c.n), hue: hue(c.rgb.map((v) => v / c.n)) });
}

function hue([r, g, b]) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  if (mx === mn) return 0;
  const hh = mx === r ? (g - b) / (mx - mn) : mx === g ? 2 + (b - r) / (mx - mn) : 4 + (r - g) / (mx - mn);
  return (hh * 60 + 360) % 360;
}

// Group by hue (greedy, around each group's running mean).
const hueDist = (a, b) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));
const groups = [];
for (const d of [...dots].sort((a, b) => a.hue - b.hue)) {
  const g = groups.find((g) => hueDist(g.hue, d.hue) <= HUE_TOL);
  if (g) {
    g.pts.push([d.x, d.y]);
    g.hue += (d.hue - g.hue) / g.pts.length;
  } else groups.push({ hue: d.hue, pts: [[d.x, d.y]] });
}

// Shortest closed path through the dots: nearest-neighbour from every start, then 2-opt.
function tour(pts) {
  const n = pts.length;
  const D = (i, j) => Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1]);
  let best = null;
  for (let s = 0; s < n; s++) {
    const used = new Array(n).fill(false);
    const t = [s];
    used[s] = true;
    while (t.length < n) {
      const l = t.at(-1);
      let bj = -1;
      for (let j = 0; j < n; j++) if (!used[j] && (bj < 0 || D(l, j) < D(l, bj))) bj = j;
      used[bj] = true;
      t.push(bj);
    }
    for (let improved = true; improved; ) {
      improved = false;
      for (let i = 0; i < n - 1; i++) for (let k = i + 2; k < n; k++) {
        const a = t[i], b = t[i + 1], c = t[k], e = t[(k + 1) % n];
        if (a !== e && D(a, c) + D(b, e) < D(a, b) + D(c, e) - 1e-9) {
          t.splice(i + 1, k - i, ...t.slice(i + 1, k + 1).reverse());
          improved = true;
        }
      }
    }
    const len = t.reduce((sum, v, i) => sum + D(v, t[(i + 1) % n]), 0);
    if (!best || len < best.len) best = { t, len };
  }
  return best.t.map((i) => pts[i]);
}

const inside = ([x, y], poly) => {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
};

// Name each outline after the current zone whose label it contains.
const current = JSON.parse(fs.readFileSync(path.join(ROOT, 'app', 'data', 'map-data.json'), 'utf8')).maps[id]?.zones || [];
const out = {};
for (const g of groups) {
  if (g.pts.length < 3) {
    console.warn(`hue ${g.hue.toFixed(0)}°: only ${g.pts.length} dot(s), skipped`);
    continue;
  }
  const poly = tour(g.pts);
  const names = current.filter((z) => inside([z.label.x, z.label.y], poly)).map((z) => z.name);
  if (names.length !== 1) throw new Error(`hue ${g.hue.toFixed(0)}° (${g.pts.length} dots) contains zone labels [${names}]; need exactly one`);
  if (out[names[0]]) throw new Error(`two colours both contain ${names[0]}`);
  out[names[0]] = poly;
  console.log(`${names[0].padEnd(22)} hue ${g.hue.toFixed(0).padStart(3)}°  ${poly.length} dots`);
}
const missing = current.map((z) => z.name).filter((n) => !out[n]);
if (missing.length) console.warn('no outline drawn for: ' + missing.join(', '));

console.log(`${dots.length} dots, drawn image ${flip ? 'rotated 180°' : 'same orientation'}`);
execFileSync('node', [path.join(__dirname, 'config-write.js'), `c[${JSON.stringify(id)}].drawn = ${JSON.stringify(out)}`]);
console.log(`Saved to zones.config.json. Now run: node tools/zones/build.js "${id}"`);
