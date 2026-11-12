// Thin-plate spline through control points: exact at every point, smooth between.
// fitTps(src, dst) -> f([u, v]) -> [u', v']. Coordinates are scaled to ~1 for stability.
function fitTps(src, dst) {
  const S = 1000, n = src.length;
  const p = src.map(([u, v]) => [u / S, v / S]);
  const U = (r2) => (r2 === 0 ? 0 : r2 * Math.log(Math.sqrt(r2)));
  const N = n + 3;
  const A = Array.from({ length: N }, () => new Float64Array(N));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) A[i][j] = U((p[i][0] - p[j][0]) ** 2 + (p[i][1] - p[j][1]) ** 2);
    A[i][n] = A[n][i] = 1;
    A[i][n + 1] = A[n + 1][i] = p[i][0];
    A[i][n + 2] = A[n + 2][i] = p[i][1];
  }
  const solve = (b) => {
    const M = A.map((r, i) => [...r, b[i]]);
    for (let c = 0; c < N; c++) {
      let piv = c;
      for (let r = c + 1; r < N; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
      [M[c], M[piv]] = [M[piv], M[c]];
      for (let r = 0; r < N; r++) {
        if (r === c) continue;
        const f = M[r][c] / M[c][c];
        for (let k = c; k <= N; k++) M[r][k] -= f * M[c][k];
      }
    }
    return M.map((r, i) => r[N] / r[i]);
  };
  const wx = solve([...dst.map((d) => d[0] / S), 0, 0, 0]);
  const wy = solve([...dst.map((d) => d[1] / S), 0, 0, 0]);
  return ([u, v]) => {
    const x = u / S, y = v / S;
    let fx = wx[n] + wx[n + 1] * x + wx[n + 2] * y, fy = wy[n] + wy[n + 1] * x + wy[n + 2] * y;
    for (let i = 0; i < n; i++) {
      const k = U((x - p[i][0]) ** 2 + (y - p[i][1]) ** 2);
      fx += wx[i] * k; fy += wy[i] * k;
    }
    return [fx * S, fy * S];
  };
}
module.exports = { fitTps };
