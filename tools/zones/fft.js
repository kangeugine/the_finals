// Minimal radix-2 complex FFT (in place) and 2D helpers. Sizes must be powers of two.

function fft1(re, im, inverse) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) (re[i] /= n), (im[i] /= n);
}

// 2D FFT of a P×P real/complex image stored row-major.
function fft2(re, im, P, inverse = false) {
  const rr = new Float64Array(P), ri = new Float64Array(P);
  for (let y = 0; y < P; y++) {
    const o = y * P;
    for (let x = 0; x < P; x++) (rr[x] = re[o + x]), (ri[x] = im[o + x]);
    fft1(rr, ri, inverse);
    for (let x = 0; x < P; x++) (re[o + x] = rr[x]), (im[o + x] = ri[x]);
  }
  for (let x = 0; x < P; x++) {
    for (let y = 0; y < P; y++) (rr[y] = re[y * P + x]), (ri[y] = im[y * P + x]);
    fft1(rr, ri, inverse);
    for (let y = 0; y < P; y++) (re[y * P + x] = rr[y]), (im[y * P + x] = ri[y]);
  }
}

// Circular cross-correlation c[d] = Σ_q a[q + d]·t[q], given FFT(a) and real t.
function correlate(FAre, FAim, t, P) {
  const re = Float64Array.from(t), im = new Float64Array(P * P);
  fft2(re, im, P);
  for (let i = 0; i < P * P; i++) {
    // FA · conj(FT)
    const r = FAre[i] * re[i] + FAim[i] * im[i];
    const m = FAim[i] * re[i] - FAre[i] * im[i];
    re[i] = r; im[i] = m;
  }
  fft2(re, im, P, true);
  return re;
}

function spectrum(a, P) {
  const re = Float64Array.from(a), im = new Float64Array(P * P);
  fft2(re, im, P);
  return [re, im];
}

module.exports = { fft2, correlate, spectrum };
