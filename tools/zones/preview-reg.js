// Debug: register one map and draw its zones onto the Ape Squad image.
//   node preview-reg.js <map id> <out.png>
const { segment, polygons } = require('./segment');
const { register } = require('./register');
const { read, write } = require('./img');
const cfg = require('./zones.config.json');

const [id, outFile] = process.argv.slice(2);
const c = cfg[id];
const t0 = Date.now();
const { im, owner, names } = segment(__dirname + '/../../maps/official/' + c.official, c.zones);
const apeFile = __dirname + '/../../maps/ape_squad_map/' + id;
const reg = register(im, owner, apeFile, { log: console.log, mode: process.env.MODE || c.align?.mode || 'texture', align: c.align || {} });
console.log(JSON.stringify({ id, ...reg, ms: Date.now() - t0 }));

const f = 1400 / read(apeFile).w;
const ape = read(apeFile, f);
const out = Buffer.from(ape.data);
const [a, b, tx, c2, d, ty] = reg.matrix;
const T = ([u, v]) => [(a * u + b * v + tx) * f, (c2 * u + d * v + ty) * f];
const dot = (x, y, col) => { for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const X = Math.round(x + dx), Y = Math.round(y + dy); if (X >= 0 && Y >= 0 && X < ape.w && Y < ape.h) out.set(col, (Y * ape.w + X) * 3); } };
const line = (p, q, col) => { const n = Math.ceil(Math.hypot(q[0] - p[0], q[1] - p[1])) + 1; for (let s = 0; s <= n; s++) dot(p[0] + (q[0] - p[0]) * s / n, p[1] + (q[1] - p[1]) * s / n, col); };
names.forEach((name, k) => {
  for (const poly of polygons(im.w, im.h, owner, k, { minArea: (im.w / 2048) ** 2 * 400, epsilon: im.w / 1000 })) {
    const P = poly.map(T);
    P.forEach((p, i) => line(p, P[(i + 1) % P.length], [255, 40, 40]));
  }
});
write(outFile, { w: ape.w, h: ape.h, data: out });
