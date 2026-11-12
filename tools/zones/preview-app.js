// Debug: render a map the way the app does (north-up via saved rotation) with
// its saved zones, straight from app/data/map-data.json.
//   node preview-app.js <map id> <out.png> [width]
const { read, write } = require('./img');
const data = require('../../app/data/map-data.json');
const [id, out, widthS] = process.argv.slice(2);
const m = data.maps[id];
const src = read(__dirname + '/../../maps/ape_squad_map/' + id, 0.25);
const S = 0.25; // src px per image px
const W = src.w / S, H = src.h / S;
const rad = (m.rotation * Math.PI) / 180, cos = Math.cos(rad), sin = Math.sin(rad);
const gridW = W * Math.abs(cos) + H * Math.abs(sin), gridH = W * Math.abs(sin) + H * Math.abs(cos);
const k = Number(widthS || 900) / gridW; // output px per image px
const ow = Math.round(gridW * k), oh = Math.round(gridH * k);
const buf = Buffer.alloc(ow * oh * 3, 30);
// Same maths as app.js imageToFrame / frameToImage.
const toFrame = (u, v) => { const dx = u - W / 2, dy = v - H / 2; return [dx * cos - dy * sin, dx * sin + dy * cos]; };
const toImage = (x, y) => [x * cos + y * sin + W / 2, -x * sin + y * cos + H / 2];
for (let y = 0; y < oh; y++) for (let x = 0; x < ow; x++) {
  const [u, v] = toImage(x / k - gridW / 2, y / k - gridH / 2);
  const sx = Math.floor(u * S), sy = Math.floor(v * S);
  if (sx >= 0 && sy >= 0 && sx < src.w && sy < src.h) src.data.copy(buf, (y * ow + x) * 3, (sy * src.w + sx) * 3, (sy * src.w + sx) * 3 + 3);
}
const px = (u, v) => { const [x, y] = toFrame(u, v); return [(x + gridW / 2) * k, (y + gridH / 2) * k]; };
const dot = (x, y, r, c) => { for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) { const X = Math.round(x + dx), Y = Math.round(y + dy); if (X >= 0 && Y >= 0 && X < ow && Y < oh) buf.set(c, (Y * ow + X) * 3); } };
for (const z of m.zones || []) {
  for (const p of z.polygons) p.forEach((a, i) => {
    const b = p[(i + 1) % p.length], A = px(...a), B = px(...b), n = Math.ceil(Math.hypot(B[0] - A[0], B[1] - A[1])) + 1;
    for (let s = 0; s <= n; s++) dot(A[0] + (B[0] - A[0]) * s / n, A[1] + (B[1] - A[1]) * s / n, 1, [255, 50, 50]);
  });
  dot(...px(z.label.x, z.label.y), 4, [255, 255, 0]);
}
write(out, { w: ow, h: oh, data: buf });
