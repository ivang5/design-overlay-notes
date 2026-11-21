/**
 * Radix-2 complex FFT (in place) and the 2-D helpers needed for masked
 * normalized cross-correlation. Sizes must be powers of two.
 */

const plans = new Map<number, { rev: Uint32Array; cos: Float64Array; sin: Float64Array }>();

function plan(n: number) {
  let p = plans.get(n);
  if (p) return p;
  const bits = Math.round(Math.log2(n));
  if (1 << bits !== n) throw new Error(`FFT size must be a power of two (got ${n})`);
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    rev[i] = r;
  }
  const cos = new Float64Array(n / 2);
  const sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / n);
    sin[i] = Math.sin((2 * Math.PI * i) / n);
  }
  p = { rev, cos, sin };
  plans.set(n, p);
  return p;
}

/**
 * In-place FFT of n complex values stored at re/im[offset + k * stride].
 * `inverse` computes the unnormalized inverse transform.
 */
export function fft1d(
  re: Float64Array,
  im: Float64Array,
  n: number,
  offset = 0,
  stride = 1,
  inverse = false,
): void {
  const { rev, cos, sin } = plan(n);
  for (let i = 0; i < n; i++) {
    const j = rev[i]!;
    if (j > i) {
      const a = offset + i * stride;
      const b = offset + j * stride;
      let t = re[a]!;
      re[a] = re[b]!;
      re[b] = t;
      t = im[a]!;
      im[a] = im[b]!;
      im[b] = t;
    }
  }
  const sign = inverse ? 1 : -1;
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const step = n / size;
    for (let start = 0; start < n; start += size) {
      for (let k = 0; k < half; k++) {
        const wr = cos[k * step]!;
        const wi = sign * sin[k * step]!;
        const a = offset + (start + k) * stride;
        const b = offset + (start + k + half) * stride;
        const xr = re[b]! * wr - im[b]! * wi;
        const xi = re[b]! * wi + im[b]! * wr;
        re[b] = re[a]! - xr;
        im[b] = im[a]! - xi;
        re[a] = re[a]! + xr;
        im[a] = im[a]! + xi;
      }
    }
  }
}

/** In-place 2-D FFT of an n×n complex array (row-major). Inverse is normalized. */
export function fft2d(re: Float64Array, im: Float64Array, n: number, inverse = false): void {
  for (let row = 0; row < n; row++) fft1d(re, im, n, row * n, 1, inverse);
  for (let col = 0; col < n; col++) fft1d(re, im, n, col, n, inverse);
  if (inverse) {
    const scale = 1 / (n * n);
    for (let i = 0; i < re.length; i++) {
      re[i]! *= scale;
      im[i]! *= scale;
    }
  }
}

export interface Spectrum {
  re: Float64Array;
  im: Float64Array;
}

/**
 * Forward transforms of two real n×n signals with one complex FFT
 * (a + i·b), separated using Hermitian symmetry.
 */
export function fftRealPair(a: Float64Array, b: Float64Array, n: number): [Spectrum, Spectrum] {
  const re = Float64Array.from(a);
  const im = Float64Array.from(b);
  fft2d(re, im, n);
  const A: Spectrum = { re: new Float64Array(n * n), im: new Float64Array(n * n) };
  const B: Spectrum = { re: new Float64Array(n * n), im: new Float64Array(n * n) };
  for (let v = 0; v < n; v++) {
    const vn = (n - v) % n;
    for (let u = 0; u < n; u++) {
      const un = (n - u) % n;
      const k = v * n + u;
      const kn = vn * n + un;
      const zr = re[k]!;
      const zi = im[k]!;
      const cr = re[kn]!; // conj(Z(-k)) = (cr, -ci)
      const ci = -im[kn]!;
      A.re[k] = (zr + cr) / 2;
      A.im[k] = (zi + ci) / 2;
      // (Z - conj Z(-k)) / (2i)
      B.re[k] = (zi - ci) / 2;
      B.im[k] = -(zr - cr) / 2;
    }
  }
  return [A, B];
}

/** X · conj(Y), element-wise. */
export function mulConj(x: Spectrum, y: Spectrum): Spectrum {
  const n = x.re.length;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    re[k] = x.re[k]! * y.re[k]! + x.im[k]! * y.im[k]!;
    im[k] = x.im[k]! * y.re[k]! - x.re[k]! * y.im[k]!;
  }
  return { re, im };
}

/** Inverse transforms of two spectra of real signals with one complex IFFT. */
export function ifftRealPair(x: Spectrum, y: Spectrum, n: number): [Float64Array, Float64Array] {
  const re = new Float64Array(n * n);
  const im = new Float64Array(n * n);
  // x + i·y
  for (let k = 0; k < re.length; k++) {
    re[k] = x.re[k]! - y.im[k]!;
    im[k] = x.im[k]! + y.re[k]!;
  }
  fft2d(re, im, n, true);
  return [re, im];
}
