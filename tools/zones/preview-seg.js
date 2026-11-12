// Debug: colour each named zone and draw its traced polygons.
//   node preview-seg.js <map id> <out.png>
const { segment, polygons } = require('./segment');
const { write } = require('./img');
const cfg = require('./zones.config.json');

const [id, outFile] = process.argv.slice(2);
const c = cfg[id];
const t0 = Date.now();
const { im, owner, names } = segment(__dirname + '/../../maps/official/' + c.official, c.zones);
const { w, h } = im;
const out = Buffer.from(im.data);
const color = (k) => [(k * 97 + 40) % 200 + 55, (k * 57 + 90) % 200 + 55, (k * 151 + 10) % 200 + 55];
for (let i = 0; i < w * h; i++) if (owner[i] >= 0) {
  const col = color(owner[i]);
  for (let j = 0; j < 3; j++) out[i * 3 + j] = (out[i * 3 + j] * 0.3 + col[j] * 0.7) | 0;
}
const dot = (x, y, r, col) => { for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) { const X = Math.round(x + dx), Y = Math.round(y + dy); if (X >= 0 && Y >= 0 && X < w && Y < h) out.set(col, (Y * w + X) * 3); } };
const line = (a, b, col) => { const n = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1])); for (let s = 0; s <= n; s++) dot(a[0] + (b[0] - a[0]) * s / n, a[1] + (b[1] - a[1]) * s / n, 1, col); };
let total = 0;
names.forEach((name, k) => {
  const polys = polygons(w, h, owner, k, { minArea: (w / 2048) ** 2 * 400, epsilon: w / 1000 });
  total += polys.reduce((s, p) => s + p.length, 0);
  console.log(`${name}: ${polys.length} piece(s), ${polys.map((p) => p.length).join('+')} pts`);
  for (const p of polys) p.forEach((pt, i) => line(pt, p[(i + 1) % p.length], [255, 255, 255]));
  for (const [x, y] of c.zones[name]) dot(x, y, 8, [255, 255, 0]);
});
write(outFile, { w, h, data: out });
console.log(`${id}: ${total} points, ${Date.now() - t0} ms`);
