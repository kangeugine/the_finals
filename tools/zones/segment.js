// Assign every zone pixel of an official map to a named seed, then trace polygons.
// Cost to step onto a pixel is low inside a zone and high on the light border
// lines, so each seed floods its own zone and stops at the borders. Pieces no
// seed can reach (separate buildings) go to the nearest seed by distance.

const { extract } = require('./extract');

const BORDER_COST = 60;
const GRAD_COST = 30;
const GRAD_FULL = 24; // blurred (r+g+b) gradient that counts as a full edge

// |∇| of (r+g+b) after a 5×5 box blur, so texture noise is damped.
function gradient({ w, h, data }) {
  const N = w * h;
  const lum = new Float32Array(N);
  for (let i = 0; i < N; i++) lum[i] = data[i * 3] + data[i * 3 + 1] + data[i * 3 + 2];
  const R = 2;
  const tmp = new Float32Array(N);
  const blur = new Float32Array(N);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0, n = 0;
    for (let k = -R; k <= R; k++) { const xx = x + k; if (xx >= 0 && xx < w) (s += lum[y * w + xx]), n++; }
    tmp[y * w + x] = s / n;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0, n = 0;
    for (let k = -R; k <= R; k++) { const yy = y + k; if (yy >= 0 && yy < h) (s += tmp[yy * w + x]), n++; }
    blur[y * w + x] = s / n;
  }
  const g = new Float32Array(N);
  for (let y = R; y < h - R; y++) for (let x = R; x < w - R; x++) {
    const i = y * w + x;
    g[i] = (Math.abs(blur[i + R] - blur[i - R]) + Math.abs(blur[i + R * w] - blur[i - R * w])) / 2;
  }
  return g;
}

function segment(file, zonesCfg) {
  const { im, zone: area } = extract(file);
  const { w, h, data } = im;
  const N = w * h;
  const names = Object.keys(zonesCfg);

  const cost = new Uint8Array(N);
  const grad = gradient(im);
  for (let i = 0; i < N; i++) {
    if (area[i] < 0) continue;
    const r = data[i * 3], g = data[i * 3 + 1], b = data[i * 3 + 2];
    const lo = Math.min(r, g, b), hi = Math.max(r, g, b);
    if (lo > 200 && hi - lo < 30) { cost[i] = 1; continue; } // label text
    const sat = (r - Math.max(g, b)) / Math.max(r, 1);
    const t = Math.min(1, Math.max(0, (0.4 - sat) / 0.15));
    // Some zones are separated only by a change of tint, not a drawn line.
    const e = Math.min(1, grad[i] / GRAD_FULL);
    cost[i] = 1 + Math.round(BORDER_COST * t + GRAD_COST * e);
  }

  // Dial's algorithm (bucket queue; costs are small ints).
  const owner = new Int16Array(N).fill(-1);
  const dist = new Float64Array(N).fill(Infinity);
  const B = BORDER_COST + GRAD_COST + 2;
  const buckets = Array.from({ length: B }, () => []);
  const seeds = [];
  names.forEach((name, k) => {
    for (const [sx, sy] of zonesCfg[name]) {
      seeds.push({ k, x: sx, y: sy });
      // Snap to the nearest zone pixel within a small radius (labels sit on zones).
      let best = -1, bd = Infinity;
      const R = Math.round(w * 0.02);
      for (let y = Math.max(0, sy - R); y < Math.min(h, sy + R); y++) for (let x = Math.max(0, sx - R); x < Math.min(w, sx + R); x++) {
        const i = y * w + x, d = (x - sx) ** 2 + (y - sy) ** 2;
        if (area[i] >= 0 && d < bd) (bd = d), (best = i);
      }
      if (best >= 0 && dist[best] > 0) {
        dist[best] = 0;
        owner[best] = k;
        buckets[0].push(best);
      }
    }
  });
  let pending = buckets[0].length;
  for (let d = 0; pending; d++) {
    const bucket = buckets[d % B];
    while (bucket.length) {
      const i = bucket.pop();
      pending--;
      if (dist[i] < d) continue;
      const x = i % w;
      for (const j of [i - w, i + w, x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1]) {
        if (j < 0 || j >= N || area[j] < 0) continue;
        const nd = d + cost[j];
        if (nd < dist[j]) {
          dist[j] = nd;
          owner[j] = owner[i];
          buckets[nd % B].push(j);
          pending++;
        }
      }
    }
  }

  // Unreached pieces: nearest seed by straight-line distance from the piece's centre.
  const seen = new Uint8Array(N);
  for (let s = 0; s < N; s++) {
    if (area[s] < 0 || owner[s] >= 0 || seen[s]) continue;
    const piece = [s];
    seen[s] = 1;
    let sx = 0, sy = 0;
    for (let p = 0; p < piece.length; p++) {
      const i = piece[p], x = i % w;
      sx += x; sy += (i / w) | 0;
      for (const j of [i - w, i + w, x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1]) {
        if (j >= 0 && j < N && area[j] >= 0 && owner[j] < 0 && !seen[j]) {
          seen[j] = 1;
          piece.push(j);
        }
      }
    }
    const cx = sx / piece.length, cy = sy / piece.length;
    const k = seeds.reduce((a, b) => (Math.hypot(a.x - cx, a.y - cy) <= Math.hypot(b.x - cx, b.y - cy) ? a : b)).k;
    for (const i of piece) owner[i] = k;
  }

  return { im, owner, names };
}

// Outer boundaries of each connected piece of zone k, as simplified polygons.
function polygons(w, h, owner, k, { minArea = 400, epsilon = 2 } = {}) {
  const inK = (x, y) => x >= 0 && y >= 0 && x < w && y < h && owner[y * w + x] === k;
  const seen = new Uint8Array(w * h);
  const out = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (owner[i] !== k || seen[i]) continue;
    // Flood the piece (marks it seen, measures it).
    const piece = [i];
    seen[i] = 1;
    for (let p = 0; p < piece.length; p++) {
      const q = piece[p], qx = q % w;
      for (const j of [q - w, q + w, qx > 0 ? q - 1 : -1, qx < w - 1 ? q + 1 : -1]) {
        if (j >= 0 && j < w * h && owner[j] === k && !seen[j]) {
          seen[j] = 1;
          piece.push(j);
        }
      }
    }
    if (piece.length < minArea) continue;
    // (x, y) is the piece's top-left-most pixel: trace its outer edge.
    out.push(simplify(traceOuter(inK, x, y), epsilon));
  }
  return out;
}

// Walk the pixel-edge boundary keeping the region on the right (clockwise in
// screen coords). Vertices are pixel corners.
function traceOuter(inK, x0, y0) {
  // Directions: 0 right, 1 down, 2 left, 3 up.
  const DX = [1, 0, -1, 0], DY = [0, 1, 0, -1];
  // Pixel to the right-hand side of an edge heading `d` from corner (x, y).
  const rightPx = (x, y, d) => [[x, y], [x - 1, y], [x - 1, y - 1], [x, y - 1]][d];
  const leftPx = (x, y, d) => [[x, y - 1], [x, y], [x - 1, y], [x - 1, y - 1]][d];
  let x = x0, y = y0, d = 0;
  const pts = [[x, y]];
  for (let guard = 0; guard < 1e7; guard++) {
    x += DX[d]; y += DY[d];
    if (x === x0 && y === y0) break;
    // Prefer turning right: at a diagonal-only touch that stays on this
    // 4-connected piece instead of jumping to the other one.
    for (const nd of [(d + 1) % 4, d, (d + 3) % 4, (d + 2) % 4]) {
      const [rx, ry] = rightPx(x, y, nd);
      const [lx, ly] = leftPx(x, y, nd);
      if (inK(rx, ry) && !inK(lx, ly)) {
        if (nd !== d) pts.push([x, y]);
        d = nd;
        break;
      }
    }
  }
  return pts;
}

// Douglas–Peucker on a closed ring.
function simplify(pts, eps) {
  if (pts.length < 4) return pts;
  const keep = new Uint8Array(pts.length);
  const rec = (a, b) => {
    const [ax, ay] = pts[a], [bx, by] = pts[b];
    const len = Math.hypot(bx - ax, by - ay) || 1;
    let best = -1, bd = eps;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((bx - ax) * (ay - pts[i][1]) - (ax - pts[i][0]) * (by - ay)) / len;
      if (d > bd) (bd = d), (best = i);
    }
    if (best >= 0) {
      keep[best] = 1;
      rec(a, best);
      rec(best, b);
    }
  };
  const mid = pts.length >> 1;
  keep[0] = keep[mid] = 1;
  rec(0, mid);
  rec(mid, pts.length - 1);
  // Close the gap between the last point and the first.
  const ring = pts.filter((_, i) => keep[i] || i === pts.length - 1);
  return ring;
}

module.exports = { segment, polygons };
