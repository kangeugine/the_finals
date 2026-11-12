// Segment the zones of an official overview map.
//   node extract.js <official image> <out.json> [preview.png]
// Zones are the reddish areas; thin low-red lines separate them and white text
// labels sit inside them. Output (official image px):
//   { w, h, zones: [{ id, area, cx, cy, bbox }], labels: [{ id, zone, cx, cy, bbox }] }
// plus `zoneMap` (base64 Int16 per pixel) so later steps can merge/name zones.

const fs = require('fs');
const { read, write } = require('./img');

const RED_MIN = 14;          // r - max(g, b) above this counts as zone
const RED_SAT = 0.3;         // ...and (r - max(g, b)) / r above this
const MIN_ZONE_FRAC = 0.0008; // drop specks smaller than this fraction of the image

function extract(file) {
  const im = read(file);
  const { w, h, data } = im;
  const N = w * h;
  const red = new Uint8Array(N);
  const white = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const r = data[i * 3], g = data[i * 3 + 1], b = data[i * 3 + 2];
    const rd = r - Math.max(g, b);
    // Borders are lighter, less saturated lines: low redness relative to r.
    red[i] = rd > RED_MIN && rd > RED_SAT * r ? 1 : 0;
    const lo = Math.min(r, g, b), hi = Math.max(r, g, b);
    white[i] = lo > 150 && hi - lo < 50 ? 1 : 0;
  }

  // 1. Connected components of red pixels (4-connected so thin borders split zones).
  const comp = new Int32Array(N).fill(-1);
  const sizes = [];
  const stack = new Int32Array(N);
  for (let s = 0; s < N; s++) {
    if (!red[s] || comp[s] !== -1) continue;
    const id = sizes.length;
    let n = 0, sp = 0;
    stack[sp++] = s;
    comp[s] = id;
    while (sp) {
      const i = stack[--sp];
      n++;
      const x = i % w;
      for (const j of [i - w, i + w, x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1]) {
        if (j >= 0 && j < N && red[j] && comp[j] === -1) {
          comp[j] = id;
          stack[sp++] = j;
        }
      }
    }
    sizes.push(n);
  }
  const keep = sizes.map((n) => n >= MIN_ZONE_FRAC * N);
  for (let i = 0; i < N; i++) if (comp[i] >= 0 && !keep[comp[i]]) comp[i] = -1;

  // 2. Outside = non-zone pixels reachable from the image border. Everything
  // else that isn't zone (text, border lines, specks) is a hole to be filled.
  const outside = new Uint8Array(N);
  let sp = 0;
  for (let x = 0; x < w; x++) for (const i of [x, (h - 1) * w + x]) if (comp[i] < 0 && !outside[i]) (outside[i] = 1), (stack[sp++] = i);
  for (let y = 0; y < h; y++) for (const i of [y * w, y * w + w - 1]) if (comp[i] < 0 && !outside[i]) (outside[i] = 1), (stack[sp++] = i);
  while (sp) {
    const i = stack[--sp];
    const x = i % w;
    for (const j of [i - w, i + w, x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1]) {
      if (j >= 0 && j < N && comp[j] < 0 && !outside[j]) {
        outside[j] = 1;
        stack[sp++] = j;
      }
    }
  }
  // Thin gaps between separate buildings can be "outside" yet only a few px
  // wide; that's fine — they stay unassigned and separate the zones.

  // 3. Fill holes by multi-source BFS from zone pixels (splits border lines
  // between the zones on either side).
  const zone = Int32Array.from(comp);
  let frontier = [];
  for (let i = 0; i < N; i++) if (zone[i] >= 0) frontier.push(i);
  while (frontier.length) {
    const next = [];
    for (const i of frontier) {
      const x = i % w;
      for (const j of [i - w, i + w, x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1]) {
        if (j >= 0 && j < N && zone[j] < 0 && !outside[j]) {
          zone[j] = zone[i];
          next.push(j);
        }
      }
    }
    frontier = next;
  }

  // 4. Label clusters: white pixels inside zones, grouped by a coarse grid so
  // letters/lines of one label join up.
  const cell = Math.max(4, Math.round(w / 220));
  const gw = Math.ceil(w / cell), gh = Math.ceil(h / cell);
  const gridCount = new Int32Array(gw * gh);
  for (let i = 0; i < N; i++) if (white[i] && zone[i] >= 0) gridCount[((i / w) / cell | 0) * gw + ((i % w) / cell | 0)]++;
  const gridLab = new Int32Array(gw * gh).fill(-1);
  const labels = [];
  const R = 2; // join cells within this many cells
  for (let s = 0; s < gw * gh; s++) {
    if (gridCount[s] < 2 || gridLab[s] !== -1) continue;
    const id = labels.length;
    const q = [s];
    gridLab[s] = id;
    let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1, px = 0;
    while (q.length) {
      const c = q.pop();
      const cx = c % gw, cy = (c / gw) | 0;
      px += gridCount[c];
      x0 = Math.min(x0, cx); y0 = Math.min(y0, cy); x1 = Math.max(x1, cx); y1 = Math.max(y1, cy);
      for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
        const n = ny * gw + nx;
        if (gridCount[n] >= 2 && gridLab[n] === -1) {
          gridLab[n] = id;
          q.push(n);
        }
      }
    }
    labels.push({ id, px, bbox: [x0 * cell, y0 * cell, (x1 + 1) * cell, (y1 + 1) * cell] });
  }
  const minLabelPx = (w / 2048) ** 2 * 150;
  const goodLabels = labels.filter((l) => l.px >= minLabelPx);
  for (const l of goodLabels) {
    const [x0, y0, x1, y1] = l.bbox;
    l.cx = Math.round((x0 + x1) / 2);
    l.cy = Math.round((y0 + y1) / 2);
    // Majority zone under the label's white pixels.
    const votes = {};
    for (let y = y0; y < Math.min(y1, h); y++) for (let x = x0; x < Math.min(x1, w); x++) {
      const i = y * w + x;
      if (white[i] && zone[i] >= 0) votes[zone[i]] = (votes[zone[i]] || 0) + 1;
    }
    l.zone = Number(Object.entries(votes).sort((a, b) => b[1] - a[1])[0]?.[0] ?? -1);
  }

  // Zone stats.
  const stats = {};
  for (let i = 0; i < N; i++) {
    const z = zone[i];
    if (z < 0) continue;
    const s = (stats[z] ??= { id: z, area: 0, sx: 0, sy: 0, bbox: [w, h, 0, 0] });
    const x = i % w, y = (i / w) | 0;
    s.area++; s.sx += x; s.sy += y;
    s.bbox[0] = Math.min(s.bbox[0], x); s.bbox[1] = Math.min(s.bbox[1], y);
    s.bbox[2] = Math.max(s.bbox[2], x); s.bbox[3] = Math.max(s.bbox[3], y);
  }
  const zones = Object.values(stats).map((s) => ({ id: s.id, area: s.area, cx: Math.round(s.sx / s.area), cy: Math.round(s.sy / s.area), bbox: s.bbox }));

  return { im, zone, zones, labels: goodLabels.map(({ id, zone, cx, cy, bbox }) => ({ id, zone, cx, cy, bbox })) };
}

function preview(file, { im, zone, zones, labels }) {
  const { w, h } = im;
  const out = Buffer.from(im.data);
  const color = (id) => [(id * 97) % 200 + 55, (id * 57) % 200 + 55, (id * 151) % 200 + 55];
  for (let i = 0; i < w * h; i++) {
    if (zone[i] < 0) continue;
    const c = color(zone[i]);
    for (let k = 0; k < 3; k++) out[i * 3 + k] = (out[i * 3 + k] * 0.35 + c[k] * 0.65) | 0;
  }
  const t = Math.max(2, Math.round(w / 700));
  for (const l of labels) {
    const [x0, y0, x1, y1] = l.bbox;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      if (x >= w || y >= h) continue;
      if (x - x0 < t || x1 - x < t || y - y0 < t || y1 - y < t) {
        const i = (y * w + x) * 3;
        out[i] = 255; out[i + 1] = 255; out[i + 2] = 0;
      }
    }
  }
  write(file, { w, h, data: out });
}

module.exports = { extract };

if (require.main === module) {
  const [src, outJson, png] = process.argv.slice(2);
  const r = extract(src);
  fs.writeFileSync(outJson, JSON.stringify({
    w: r.im.w, h: r.im.h, zones: r.zones, labels: r.labels,
    zoneMap: Buffer.from(Int16Array.from(r.zone).buffer).toString('base64'),
  }));
  if (png) preview(png, r);
  console.log(`zones: ${r.zones.length}`);
  for (const z of r.zones.sort((a, b) => b.area - a.area)) console.log(`  zone ${z.id}: area ${z.area} centre ${z.cx},${z.cy}`);
  console.log(`labels: ${r.labels.length}`);
  for (const l of r.labels) console.log(`  label ${l.id}: zone ${l.zone} centre ${l.cx},${l.cy} bbox ${l.bbox.join(',')}`);
}
