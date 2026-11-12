// Per-zone hand corrections from a screenshot of the app with point pairs
// (current zone point -> where it should be). Fits, per zone and per image axis,
// a scale + shift (or just a shift when the points barely spread on that axis),
// composes it onto any existing fix, and saves it to zones.config.json as
// align.zoneFix. Then run: node build.js "<map id>"
//   node fix-zones.js <pairs.json>
// pairs.json: { "map": id, "screen": { "k": px per grid unit, "sx0": screen x of grid x=0,
//               "sy0": screen y of grid y=0 }, "pairs": [{ "zone", "from": [x, y], "to": [x, y] }],
//               "groups": { name: [zones] }  (optional: zones that touch share one fit),
//               "shiftOnly": [zones or groups] (optional: never rescale these),
//               "tps": [zones or groups] (optional: smooth warp exact at every point —
//                       for curved/irregular areas a straight per-axis fit can't follow) }
// Each run appends a step to align.zoneFix[zone] (applied in order by build.js).
const fs = require('fs');
const { probe } = require('./img');
const CONFIG_FILE = __dirname + '/zones.config.json';
const DATA = require('../../app/data/map-data.json');

const spec = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
const m = DATA.maps[spec.map];
const { w: W, h: H } = probe(__dirname + '/../../maps/ape_squad_map/' + spec.map);

// Screenshot px -> grid -> image px, same maths as app.js.
const rad = (m.rotation * Math.PI) / 180, cos = Math.cos(rad), sin = Math.sin(rad);
const ac = Math.abs(cos) < 1e-9 ? 0 : Math.abs(cos), as = Math.abs(sin) < 1e-9 ? 0 : Math.abs(sin);
const gridW = W * ac + H * as, gridH = W * as + H * ac;
const { k, sx0, sy0 } = spec.screen;
const toImage = ([sx, sy]) => {
  const gx = (sx - sx0) / k, gy = (sy0 - sy) / k;
  const fx = gx - gridW / 2, fy = gridH / 2 - gy;
  return [fx * cos + fy * sin + W / 2, -fx * sin + fy * cos + H / 2];
};

const fitAxis = (src, dst, extent) => {
  const n = src.length, ms = src.reduce((a, b) => a + b) / n, md = dst.reduce((a, b) => a + b) / n;
  const spread = Math.max(...src) - Math.min(...src);
  if (n < 2 || spread < 0.25 * extent) return [1, md - ms];
  let sxy = 0, sxx = 0;
  src.forEach((x, i) => { sxy += (x - ms) * (dst[i] - md); sxx += (x - ms) ** 2; });
  const s = sxy / sxx;
  return [s, md - s * ms];
};

const groupOf = {};
for (const [g, zs] of Object.entries(spec.groups ?? {})) for (const z of zs) groupOf[z] = g;
const members = (g) => spec.groups?.[g] ?? [g];
const byGroup = {};
for (const p of spec.pairs) (byGroup[groupOf[p.zone] ?? p.zone] ??= []).push({ from: toImage(p.from), to: toImage(p.to) });
const c = cfg[spec.map];
c.align.zoneFix ??= {};
for (const [g, pts] of Object.entries(byGroup)) {
  const zs = members(g).map((name) => m.zones.find((q) => q.name === name) ?? (() => { throw new Error('no zone ' + name); })());
  const all = zs.flatMap((z) => z.polygons.flat());
  const shiftOnly = spec.shiftOnly?.includes(g);
  const ext = (j) => (shiftOnly ? Infinity : Math.max(...all.map((p) => p[j])) - Math.min(...all.map((p) => p[j])));
  const u = fitAxis(pts.map((p) => p.from[0]), pts.map((p) => p.to[0]), ext(0));
  const v = fitAxis(pts.map((p) => p.from[1]), pts.map((p) => p.to[1]), ext(1));
  const useTps = spec.tps?.includes(g);
  const r = (a) => a.map((x) => Math.round(x));
  const step = useTps
    ? { tps: { src: pts.map((p) => r(p.from)), dst: pts.map((p) => r(p.to)) } }
    : { u: [+u[0].toFixed(4), +u[1].toFixed(1)], v: [+v[0].toFixed(4), +v[1].toFixed(1)] };
  for (const z of zs) {
    const prev = c.align.zoneFix[z.name];
    c.align.zoneFix[z.name] = [...(Array.isArray(prev) ? prev : prev ? [prev] : []), step];
  }
  const err = useTps ? [0] : pts.map((p) => Math.hypot(u[0] * p.from[0] + u[1] - p.to[0], v[0] * p.from[1] + v[1] - p.to[1]) * k);
  if (useTps) { console.log(`${g.padEnd(22)} ${pts.length} pt  smooth warp (exact at every point)`); continue; }
  console.log(`${g.padEnd(22)} ${pts.length} pt  u ×${u[0].toFixed(3)} ${u[1] >= 0 ? '+' : ''}${u[1].toFixed(0)}  v ×${v[0].toFixed(3)} ${v[1] >= 0 ? '+' : ''}${v[1].toFixed(0)}  max error ${Math.max(...err).toFixed(1)} screenshot px`);
}
require('child_process').execFileSync('node', [__dirname + '/config-write.js', `Object.assign(c[${JSON.stringify(spec.map)}].align, ${JSON.stringify({ zoneFix: c.align.zoneFix })})`]);
