// Debug: render the official map's underlay with the red tint removed (per-zone
// standardised luminance), optionally rotated by a multiple of 90° to compare
// with an Ape Squad image.   node underlay.js <map id> <out.png> [rot90 count]
const { segment } = require('./segment');
const { write } = require('./img');
const cfg = require('./zones.config.json');
const [id, out, rotS] = process.argv.slice(2);
const c = cfg[id];
const { im, owner } = segment(__dirname + '/../../maps/official/' + c.official, c.zones);
const { w, h, data } = im;
const st = {};
const lum = (i) => data[i * 3] + data[i * 3 + 1] + data[i * 3 + 2];
for (let i = 0; i < w * h; i++) { const k = owner[i]; const s = (st[k] ??= { n: 0, s: 0, s2: 0 }); s.n++; s.s += lum(i); s.s2 += lum(i) ** 2; }
for (const s of Object.values(st)) { s.m = s.s / s.n; s.sd = Math.sqrt(s.s2 / s.n - s.m * s.m) || 1; }
let img = { w, h, data: Buffer.alloc(w * h * 3) };
for (let i = 0; i < w * h; i++) { const s = st[owner[i]]; const v = Math.max(0, Math.min(255, 128 + 40 * (lum(i) - s.m) / s.sd)); img.data[i * 3] = img.data[i * 3 + 1] = img.data[i * 3 + 2] = v; }
for (let r = 0; r < (Number(rotS) || 0); r++) { // rotate 90° clockwise
  const o = Buffer.alloc(img.w * img.h * 3);
  for (let y = 0; y < img.h; y++) for (let x = 0; x < img.w; x++) img.data.copy(o, (x * img.h + (img.h - 1 - y)) * 3, (y * img.w + x) * 3, (y * img.w + x) * 3 + 3);
  img = { w: img.h, h: img.w, data: o };
}
write(out, img);
