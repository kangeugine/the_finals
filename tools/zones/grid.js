// Debug: draw a coordinate grid (in FULL-res px of the source) over a downscaled image.
//   node grid.js <image> <out.png> <displayWidth> <step px (full res)> [crop x,y,w,h full-res]
const { read, write } = require('./img');
const [src, out, dispW, stepS, cropS] = process.argv.slice(2);
const full = read(src);
let [cx, cy, cw, ch] = cropS ? cropS.split(',').map(Number) : [0, 0, full.w, full.h];
const f = Number(dispW) / cw, step = Number(stepS);
const W = Math.round(cw * f), H = Math.round(ch * f);
const data = Buffer.alloc(W * H * 3);
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const sx = Math.min(full.w - 1, Math.floor(cx + x / f)), sy = Math.min(full.h - 1, Math.floor(cy + y / f));
  full.data.copy(data, (y * W + x) * 3, (sy * full.w + sx) * 3, (sy * full.w + sx) * 3 + 3);
}
const put = (x, y, c) => { if (x >= 0 && y >= 0 && x < W && y < H) data.set(c, (y * W + x) * 3); };
for (let g = Math.ceil(cx / step) * step; g < cx + cw; g += step) {
  const x = Math.round((g - cx) * f), major = g % (step * 5) === 0;
  for (let y = 0; y < H; y++) { put(x, y, major ? [255, 255, 0] : [0, 255, 255]); if (major) put(x + 1, y, [255, 255, 0]); }
}
for (let g = Math.ceil(cy / step) * step; g < cy + ch; g += step) {
  const y = Math.round((g - cy) * f), major = g % (step * 5) === 0;
  for (let x = 0; x < W; x++) { put(x, y, major ? [255, 255, 0] : [0, 255, 255]); if (major) put(x, y + 1, [255, 255, 0]); }
}
write(out, { w: W, h: H, data });
