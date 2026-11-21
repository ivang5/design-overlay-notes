/**
 * Image registration between a capture's screenshot (reference) and a fresh
 * screenshot of the live view, restricted to masked regions (the Figma
 * canvas minus Figma UI and our own marks).
 *
 * Model: live = s · ref + t (pan + zoom; Figma never rotates the canvas).
 *
 *  - refine(): Gauss–Newton (Lucas–Kanade) on image pyramids, starting from a
 *    predicted transform. Fast and precise; used after every pan/zoom.
 *  - search(): masked normalized cross-correlation via FFT over a set of
 *    candidate scales (Padfield 2012), for when there is no usable prediction.
 *
 * All transforms are in level-0 continuous pixel coordinates of the given
 * images (see image.ts).
 */
import type { ViewTransform } from '../shared/view-transform';
import { fftRealPair, ifftRealPair, mulConj } from './fft';
import {
  blur,
  countMask,
  createMask,
  cropToMask,
  downsample,
  downsampleMask,
  gradients,
  maskAt,
  rescale,
  rescaleMask,
  sample,
  type GrayImage,
  type Mask,
} from './image';

export interface Pyramid {
  images: GrayImage[];
  masks: Mask[];
  /** Lazily computed gradients per level. */
  grads: ({ gx: GrayImage; gy: GrayImage } | undefined)[];
}

export function buildPyramid(image: GrayImage, mask: Mask, minSize = 12, maxLevels = 6): Pyramid {
  const images = [blur(image, 0.7)];
  const masks = [mask];
  while (images.length < maxLevels) {
    const prev = images[images.length - 1]!;
    if (Math.min(prev.width, prev.height) / 2 < minSize) break;
    images.push(downsample(blur(prev, 0.6)));
    masks.push(downsampleMask(masks[masks.length - 1]!));
  }
  return { images, masks, grads: images.map(() => undefined) };
}

function gradsAt(p: Pyramid, level: number) {
  let g = p.grads[level];
  if (!g) {
    g = gradients(p.images[level]!);
    p.grads[level] = g;
  }
  return g;
}

function fromLevel(t: ViewTransform, level: number): ViewTransform {
  const f = 2 ** level;
  return { s: t.s, tx: t.tx * f, ty: t.ty * f };
}

export interface MatchScore {
  /** Zero-mean normalized cross-correlation over the overlap (−1..1). */
  ncc: number;
  /** Overlapping usable pixels (at the scored level). */
  valid: number;
  /** Intensity standard deviation of the reference inside the overlap (texture). */
  std: number;
}

/** ZNCC between ref(x) and live(T(x)) over pixels usable in both. */
export function scoreAt(
  ref: GrayImage,
  refMask: Mask,
  live: GrayImage,
  liveMask: Mask,
  t: ViewTransform,
  stride = 1,
): MatchScore {
  let n = 0;
  let sr = 0;
  let sl = 0;
  let srr = 0;
  let sll = 0;
  let srl = 0;
  const w = ref.width;
  for (let j = 0; j < ref.height; j += stride) {
    const Y = j + 0.5;
    const v = t.s * Y + t.ty;
    for (let i = 0; i < w; i += stride) {
      if (!refMask.data[j * w + i]) continue;
      const X = i + 0.5;
      const u = t.s * X + t.tx;
      if (!maskAt(liveMask, u, v)) continue;
      const r = ref.data[j * w + i]!;
      const l = sample(live, u, v);
      n++;
      sr += r;
      sl += l;
      srr += r * r;
      sll += l * l;
      srl += r * l;
    }
  }
  if (n < 2) return { ncc: 0, valid: n, std: 0 };
  const varR = srr - (sr * sr) / n;
  const varL = sll - (sl * sl) / n;
  const std = Math.sqrt(Math.max(0, varR / n));
  if (varR <= 1e-6 || varL <= 1e-6) return { ncc: 0, valid: n, std };
  return { ncc: (srl - (sr * sl) / n) / Math.sqrt(varR * varL), valid: n, std };
}

/** Solve A x = b for a small dense system (Gaussian elimination, partial pivoting). */
function solve(a: number[][], b: number[]): number[] | null {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]!]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(m[r]![col]!) > Math.abs(m[pivot]![col]!)) pivot = r;
    if (Math.abs(m[pivot]![col]!) < 1e-12) return null;
    [m[col], m[pivot]] = [m[pivot]!, m[col]!];
    for (let r = col + 1; r < n; r++) {
      const f = m[r]![col]! / m[col]![col]!;
      for (let c = col; c <= n; c++) m[r]![c]! -= f * m[col]![c]!;
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let acc = m[r]![n]!;
    for (let c = r + 1; c < n; c++) acc -= m[r]![c]! * x[c]!;
    x[r] = acc / m[r]![r]!;
  }
  return x;
}

const HUBER_K = 10;
const MAX_SAMPLES = 24_000;

interface LevelFit {
  /** Normal equations for (s, qx, qy). */
  H: number[][];
  g: number[];
  /** Mean robust cost over the pixels used. */
  cost: number;
  count: number;
}

/** Huber-weighted residuals and Jacobian of live(s·(x − c) + q) − ref(x). */
function evaluateFit(
  ref: GrayImage,
  refMask: Mask,
  live: GrayImage,
  liveMask: Mask,
  grads: { gx: GrayImage; gy: GrayImage },
  s: number,
  qx: number,
  qy: number,
  cx: number,
  cy: number,
  stride: number,
  withJacobian: boolean,
): LevelFit {
  const H = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  const g = [0, 0, 0];
  let cost = 0;
  let count = 0;
  const w = ref.width;
  for (let j = 0; j < ref.height; j += stride) {
    const Y = j + 0.5 - cy;
    const v = s * Y + qy;
    if (v < 0.5 || v > live.height - 0.5) continue;
    for (let i = 0; i < w; i += stride) {
      if (!refMask.data[j * w + i]) continue;
      const X = i + 0.5 - cx;
      const u = s * X + qx;
      if (u < 0.5 || u > live.width - 0.5 || !maskAt(liveMask, u, v)) continue;
      const residual = sample(live, u, v) - ref.data[j * w + i]!;
      const abs = Math.abs(residual);
      cost += abs <= HUBER_K ? 0.5 * residual * residual : HUBER_K * (abs - 0.5 * HUBER_K);
      count++;
      if (!withJacobian) continue;
      const weight = abs <= HUBER_K ? 1 : HUBER_K / abs;
      const gxv = sample(grads.gx, u, v);
      const gyv = sample(grads.gy, u, v);
      const j0 = gxv * X + gyv * Y;
      const wr = weight * residual;
      g[0]! += j0 * wr;
      g[1]! += gxv * wr;
      g[2]! += gyv * wr;
      H[0]![0]! += weight * j0 * j0;
      H[0]![1]! += weight * j0 * gxv;
      H[0]![2]! += weight * j0 * gyv;
      H[1]![1]! += weight * gxv * gxv;
      H[1]![2]! += weight * gxv * gyv;
      H[2]![2]! += weight * gyv * gyv;
    }
  }
  H[1]![0] = H[0]![1]!;
  H[2]![0] = H[0]![2]!;
  H[2]![1] = H[1]![2]!;
  return { H, g, cost: count ? cost / count : Infinity, count };
}

/**
 * Levenberg–Marquardt refinement of (s, t) at one pyramid level. The scale is
 * parameterised around the reference centre for good conditioning:
 * live = s · (x − c) + q. Steps that do not lower the robust cost are
 * rejected, so a good starting point can only improve.
 */
function refineLevel(
  ref: GrayImage,
  refMask: Mask,
  live: GrayImage,
  liveMask: Mask,
  grads: { gx: GrayImage; gy: GrayImage },
  start: ViewTransform,
  iterations: number,
  lockScale = false,
): ViewTransform | null {
  const cx = ref.width / 2;
  const cy = ref.height / 2;
  let s = start.s;
  let qx = s * cx + start.tx;
  let qy = s * cy + start.ty;

  const usable = countMask(refMask);
  if (usable < 16) return null;
  const stride = Math.max(1, Math.floor(Math.sqrt(usable / MAX_SAMPLES)));
  const minCount = Math.max(16, usable / (stride * stride) * 0.05);
  let fit = evaluateFit(ref, refMask, live, liveMask, grads, s, qx, qy, cx, cy, stride, true);
  if (fit.count < minCount) return null;
  let lambda = 1e-3;
  const radius = Math.hypot(cx, cy);

  for (let iter = 0; iter < iterations; iter++) {
    const A = fit.H.map((row, a) => row.map((v, b) => (a === b ? v * (1 + lambda) + 1e-9 : v)));
    // With a locked scale (trusted zoom prediction) only the position is refined.
    const delta = lockScale
      ? ((d) => (d ? [0, d[0]!, d[1]!] : null))(
          solve(
            [
              [A[1]![1]!, A[1]![2]!],
              [A[2]![1]!, A[2]![2]!],
            ],
            [-fit.g[1]!, -fit.g[2]!],
          ),
        )
      : solve(
          A,
          fit.g.map((v) => -v),
        );
    if (!delta) return null;
    const ds = Math.max(-0.1 * s, Math.min(0.1 * s, delta[0]!));
    const dqx = Math.max(-6, Math.min(6, delta[1]!));
    const dqy = Math.max(-6, Math.min(6, delta[2]!));
    const ns = s + ds;
    if (!(ns > 0) || !Number.isFinite(ns)) return null;
    const trial = evaluateFit(ref, refMask, live, liveMask, grads, ns, qx + dqx, qy + dqy, cx, cy, stride, true);
    if (trial.count >= minCount && trial.cost <= fit.cost) {
      s = ns;
      qx += dqx;
      qy += dqy;
      fit = trial;
      lambda = Math.max(1e-6, lambda / 3);
      if (Math.abs(ds) * radius < 0.02 && Math.abs(dqx) < 0.02 && Math.abs(dqy) < 0.02) break;
    } else {
      lambda *= 8;
      if (lambda > 1e6) break;
    }
  }
  return { s, tx: qx - s * cx, ty: qy - s * cy };
}

export interface RefineResult extends MatchScore {
  transform: ViewTransform;
  /** ZNCC at full working resolution (diagnostics; sensitive to rendering detail). */
  nccFine: number;
}

/**
 * Confidence is measured one level above the finest: Figma re-renders text and
 * thin lines differently at each zoom level, which lowers fine-scale
 * correlation even for a perfect match.
 */
const SCORE_LEVEL = 1;

/**
 * Pyramid levels to compare at a given base level: when the live view shows
 * the reference much smaller (zoomed out) or larger (zoomed in), the finer
 * image is taken from a coarser level so both have similar detail. Comparing
 * a sharp reference with a 7× smaller live image pixel by pixel would
 * otherwise mostly measure the detail difference.
 */
function levelPair(refP: Pyramid, liveP: Pyramid, s: number, level: number): { lr: number; ll: number } {
  const shift = Math.round(Math.log2(s));
  const maxRef = refP.images.length - 1;
  const maxLive = liveP.images.length - 1;
  let lr = Math.min(level, maxRef);
  let ll = Math.min(level, maxLive);
  if (shift > 0) ll = Math.min(maxLive, ll + shift);
  else if (shift < 0) lr = Math.min(maxRef, lr - shift);
  return { lr, ll };
}

/** Transform between ref level `lr` and live level `ll` coordinates. */
function toPair(t: ViewTransform, lr: number, ll: number): ViewTransform {
  return { s: t.s * 2 ** (lr - ll), tx: t.tx / 2 ** ll, ty: t.ty / 2 ** ll };
}

function fromPair(t: ViewTransform, lr: number, ll: number): ViewTransform {
  return { s: t.s * 2 ** (ll - lr), tx: t.tx * 2 ** ll, ty: t.ty * 2 ** ll };
}

/** Coarse-to-fine refinement from `startLevel` down to `endLevel`. */
export function refine(
  refP: Pyramid,
  liveP: Pyramid,
  init: ViewTransform,
  startLevel: number,
  endLevel = 0,
  lockScale = false,
): RefineResult | null {
  const top = Math.min(startLevel, refP.images.length - 1, liveP.images.length - 1);
  let t: ViewTransform = init;
  for (let level = top; level >= endLevel; level--) {
    const { lr, ll } = levelPair(refP, liveP, t.s, level);
    const next = refineLevel(
      refP.images[lr]!,
      refP.masks[lr]!,
      liveP.images[ll]!,
      liveP.masks[ll]!,
      gradsAt(liveP, ll),
      toPair(t, lr, ll),
      level === endLevel ? 12 : 10,
      lockScale,
    );
    if (!next) return null;
    t = fromPair(next, lr, ll);
  }
  const scoreLevel = Math.min(Math.max(endLevel, SCORE_LEVEL), refP.images.length - 1, liveP.images.length - 1);
  const score = scoreLevelAt(refP, liveP, t, scoreLevel);
  const fine = scoreLevel === endLevel ? score : scoreLevelAt(refP, liveP, t, endLevel);
  return { transform: t, ...score, nccFine: fine.ncc };
}

function scoreLevelAt(refP: Pyramid, liveP: Pyramid, t: ViewTransform, level: number): MatchScore {
  const { lr, ll } = levelPair(refP, liveP, t.s, level);
  const ref = refP.images[lr]!;
  const stride = Math.max(1, Math.floor(Math.sqrt((ref.width * ref.height) / 60_000)));
  const score = scoreAt(ref, refP.masks[lr]!, liveP.images[ll]!, liveP.masks[ll]!, toPair(t, lr, ll), stride);
  // Report the overlap in level-0 reference pixels regardless of level and sampling stride.
  return { ...score, valid: score.valid * stride * stride * 4 ** lr };
}

export interface SearchCandidate {
  transform: ViewTransform;
  ncc: number;
  overlap: number;
}

function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

export interface TranslationPeak {
  dx: number;
  dy: number;
  ncc: number;
  overlap: number;
}

/**
 * Best translation d such that live(x + d) ≈ ref(x), by masked normalized
 * cross-correlation (all offsets at once via FFT).
 */
export function searchTranslation(
  ref: GrayImage,
  refMask: Mask,
  live: GrayImage,
  liveMask: Mask,
  minOverlap: number,
  minStd = 2,
): TranslationPeak | null {
  return searchTranslationPeaks(ref, refMask, live, liveMask, minOverlap, 1, minStd)[0] ?? null;
}

/**
 * Up to `count` distinct correlation peaks (at least `separation` pixels
 * apart), best first. Repetitive designs (rows of similar frames) produce
 * several strong peaks; the caller refines each and keeps the best.
 */
export function searchTranslationPeaks(
  ref: GrayImage,
  refMask: Mask,
  live: GrayImage,
  liveMask: Mask,
  minOverlap: number,
  count: number,
  minStd = 2,
  separation = 6,
): TranslationPeak[] {
  const P = nextPow2(Math.max(ref.width + live.width, ref.height + live.height));
  const size = P * P;
  const ml = new Float64Array(size);
  const mlL = new Float64Array(size);
  const mlL2 = new Float64Array(size);
  const mr = new Float64Array(size);
  const mrR = new Float64Array(size);
  const mrR2 = new Float64Array(size);
  for (let j = 0; j < live.height; j++) {
    for (let i = 0; i < live.width; i++) {
      const k = j * live.width + i;
      if (!liveMask.data[k]) continue;
      const v = live.data[k]!;
      const p = j * P + i;
      ml[p] = 1;
      mlL[p] = v;
      mlL2[p] = v * v;
    }
  }
  for (let j = 0; j < ref.height; j++) {
    for (let i = 0; i < ref.width; i++) {
      const k = j * ref.width + i;
      if (!refMask.data[k]) continue;
      const v = ref.data[k]!;
      const p = j * P + i;
      mr[p] = 1;
      mrR[p] = v;
      mrR2[p] = v * v;
    }
  }
  const [Fml, FmlL] = fftRealPair(ml, mlL, P);
  const [FmlL2, Fmr] = fftRealPair(mlL2, mr, P);
  const [FmrR, FmrR2] = fftRealPair(mrR, mrR2, P);
  const [N, Sl] = ifftRealPair(mulConj(Fml, Fmr), mulConj(FmlL, Fmr), P);
  const [Sr, Sll] = ifftRealPair(mulConj(Fml, FmrR), mulConj(FmlL2, Fmr), P);
  const [Srr, Slr] = ifftRealPair(mulConj(Fml, FmrR2), mulConj(FmlL, FmrR), P);

  const all: TranslationPeak[] = [];
  const nccMap = new Float32Array(size).fill(-2);
  const minVar = minStd * minStd;
  for (let v = 0; v < P; v++) {
    const dy = v > P - ref.height ? v - P : v;
    if (dy >= live.height) continue;
    for (let u = 0; u < P; u++) {
      const dx = u > P - ref.width ? u - P : u;
      if (dx >= live.width) continue;
      const k = v * P + u;
      const n = Math.round(N[k]!);
      if (n < minOverlap) continue;
      const varL = Sll[k]! - (Sl[k]! * Sl[k]!) / n;
      const varR = Srr[k]! - (Sr[k]! * Sr[k]!) / n;
      if (varL < n * minVar || varR < n * minVar) continue;
      const ncc = (Slr[k]! - (Sl[k]! * Sr[k]!) / n) / Math.sqrt(varL * varR);
      if (ncc > 0.2) {
        nccMap[k] = ncc;
        all.push({ dx, dy, ncc, overlap: n });
      }
    }
  }
  // Keep local maxima only (a peak's neighbours are not separate candidates).
  const isPeak = (p: TranslationPeak) => {
    const u = (p.dx + P) % P;
    const v = (p.dy + P) % P;
    const value = p.ncc;
    for (let dv = -1; dv <= 1; dv++) {
      for (let du = -1; du <= 1; du++) {
        if ((du || dv) && nccMap[((v + dv + P) % P) * P + ((u + du + P) % P)]! > value) return false;
      }
    }
    return true;
  };
  const maxima = all.filter(isPeak);
  all.length = 0;
  all.push(...maxima.sort((a, b) => b.ncc - a.ncc));
  const peaks: TranslationPeak[] = [];
  for (const p of all) {
    if (peaks.every((q) => Math.max(Math.abs(q.dx - p.dx), Math.abs(q.dy - p.dy)) >= separation)) {
      peaks.push(p);
      if (peaks.length >= count) break;
    }
  }
  return peaks;
}

/**
 * Try each candidate scale at one pyramid level; returns candidates sorted
 * by correlation (transforms in level-0 coordinates).
 */
export function searchScales(
  refP: Pyramid,
  liveP: Pyramid,
  level: number,
  scales: readonly number[],
  minOverlapFraction = 0.12,
  peaksPerScale = 5,
): SearchCandidate[] {
  const ref = refP.images[level]!;
  const refMask = refP.masks[level]!;
  const live = liveP.images[level]!;
  const liveMask = liveP.masks[level]!;
  const liveCount = countMask(liveMask);
  const out: SearchCandidate[] = [];
  // Correlate only the usable (canvas) areas: much smaller FFTs.
  const liveCrop = cropToMask(live, liveMask);
  const refCrop = cropToMask(ref, refMask);
  for (const s of scales) {
    if (s <= 1) {
      const r = rescale(ref, s);
      const m = rescaleMask(refMask, s);
      const crop = cropToMask(r, m);
      const minOverlap = Math.max(24, minOverlapFraction * Math.min(countMask(m), liveCount));
      // ref' = ref scaled by (r.width / ref.width) ≈ s
      const sx = r.width / ref.width;
      for (const peak of searchTranslationPeaks(crop.image, crop.mask, liveCrop.image, liveCrop.mask, minOverlap, peaksPerScale)) {
        const dx = peak.dx + liveCrop.x0 - crop.x0;
        const dy = peak.dy + liveCrop.y0 - crop.y0;
        out.push({ transform: fromLevel({ s: sx, tx: dx, ty: dy }, level), ncc: peak.ncc, overlap: peak.overlap });
      }
    } else {
      const l = rescale(live, 1 / s);
      const m = rescaleMask(liveMask, 1 / s);
      const crop = cropToMask(l, m);
      const minOverlap = Math.max(24, minOverlapFraction * Math.min(countMask(refMask), countMask(m)));
      const f = live.width / l.width; // ≈ s
      for (const peak of searchTranslationPeaks(refCrop.image, refCrop.mask, crop.image, crop.mask, minOverlap, peaksPerScale)) {
        const dx = peak.dx + crop.x0 - refCrop.x0;
        const dy = peak.dy + crop.y0 - refCrop.y0;
        out.push({ transform: fromLevel({ s: f, tx: dx * f, ty: dy * f }, level), ncc: peak.ncc, overlap: peak.overlap });
      }
    }
  }
  out.sort((a, b) => b.ncc - a.ncc);
  return out;
}

/**
 * Keep the best candidate of each cluster: candidates that put the reference
 * centre within `radius` px of each other at nearly the same scale converge
 * to the same answer when refined.
 */
function distinctCandidates(candidates: SearchCandidate[], limit: number, width: number, height: number): SearchCandidate[] {
  const radius = Math.max(8, 0.025 * width);
  const centre = (t: ViewTransform) => ({ x: t.s * (width / 2) + t.tx, y: t.s * (height / 2) + t.ty });
  const kept: SearchCandidate[] = [];
  for (const c of candidates) {
    const p = centre(c.transform);
    const duplicate = kept.some((k) => {
      const q = centre(k.transform);
      return Math.hypot(p.x - q.x, p.y - q.y) < radius && Math.abs(Math.log(k.transform.s / c.transform.s)) < 0.05;
    });
    if (!duplicate) {
      kept.push(c);
      if (kept.length >= limit) break;
    }
  }
  return kept;
}

export interface AlignOptions {
  /** Predicted transform (e.g. dead-reckoned from wheel events). */
  seed?: ViewTransform | null;
  /** Expected scale from Figma's zoom readout (live zoom ÷ capture zoom). */
  scaleHint?: number | null;
  /** Relative uncertainty of the hint (default ±10 %). Narrower → fewer scales to search. */
  scaleTolerance?: number | null;
  /** The seed's scale is exact (trusted zoom prediction): refine the position only first. */
  lockScale?: boolean;
  /** Accept a match only above this correlation. */
  minNcc?: number;
}

export interface AlignAttempt extends MatchScore {
  transform: ViewTransform;
  method: 'refine' | 'search';
  nccFine: number;
}

export interface AlignResult extends MatchScore {
  transform: ViewTransform;
  method: 'refine' | 'search';
  nccFine: number;
  confident: boolean;
  /** Every refinement tried (for diagnostics). */
  attempts: AlignAttempt[];
  /** Milliseconds per stage (diagnostics). */
  timings: Record<string, number>;
}

const DEFAULT_MIN_NCC = 0.8;
/** Threshold for confirming a position-only refinement of an exact zoom/pan prediction. */
const LOCKED_MIN_NCC = 0.72;
const MIN_VALID_PIXELS = 900; // at level 0 (working resolution)
const MIN_TEXTURE_STD = 2.5;

function isConfident(r: MatchScore, minNcc: number): boolean {
  return r.ncc >= minNcc && r.valid >= MIN_VALID_PIXELS && r.std >= MIN_TEXTURE_STD;
}

/** Width (level-0 px) of the usable area of a pyramid. */
function maskWidth(p: Pyramid): number {
  const mask = p.masks[0]!;
  let x0 = mask.width;
  let x1 = 0;
  for (let j = 0; j < mask.height; j += 4) {
    for (let i = 0; i < mask.width; i++) {
      if (mask.data[j * mask.width + i]) {
        if (i < x0) x0 = i;
        if (i > x1) x1 = i;
      }
    }
  }
  return Math.max(1, x1 - x0 + 1);
}

/**
 * Search level for an expected scale: the live canvas about ~100 px wide, but
 * fine enough that the reference (scaled by `scale`) stays ≥ 24 px wide, and
 * coarse enough that both fit a 512-point FFT.
 */
function searchLevel(refP: Pyramid, liveP: Pyramid, scale: number): number {
  const liveWidth = maskWidth(liveP);
  const templateWidth = maskWidth(refP) * scale;
  const maxLevel = Math.min(refP.images.length, liveP.images.length) - 1;
  let level = Math.min(levelForWidth(liveP, 100), Math.max(0, Math.floor(Math.log2(templateWidth / 24))));
  while (level < maxLevel && (liveWidth + templateWidth) / 2 ** level > 480) level++;
  return Math.max(0, Math.min(level, maxLevel));
}

/** Pyramid level at which the usable (canvas) area is about `target` pixels wide. */
function levelForWidth(p: Pyramid, target: number): number {
  const mask = p.masks[0]!;
  let x0 = mask.width;
  let x1 = 0;
  for (let j = 0; j < mask.height; j += 4) {
    for (let i = 0; i < mask.width; i++) {
      if (mask.data[j * mask.width + i]) {
        if (i < x0) x0 = i;
        if (i > x1) x1 = i;
      }
    }
  }
  const width = Math.max(1, x1 - x0 + 1);
  let level = 0;
  while (level + 1 < p.images.length && width / 2 ** level > target * 1.4) level++;
  return level;
}

function logRange(center: number, halfSteps: number, step: number): number[] {
  const out: number[] = [];
  for (let k = -halfSteps; k <= halfSteps; k++) out.push(center * Math.exp(k * step));
  return out;
}

/**
 * Find where the reference (capture) appears in the live view.
 * Tries a cheap local refinement from the seed first, then a scale/translation
 * search (narrow around the zoom hint when available, broad otherwise).
 */
export function align(refP: Pyramid, liveP: Pyramid, options: AlignOptions = {}): AlignResult | null {
  const minNcc = options.minNcc ?? DEFAULT_MIN_NCC;
  const coarse = Math.min(2, refP.images.length - 1, liveP.images.length - 1);

  let best: AlignResult | null = null;
  const attempts: AlignAttempt[] = [];
  const timings: Record<string, number> = {};
  let clock = performance.now();
  const lap = (stage: string) => {
    const now = performance.now();
    timings[stage] = Math.round(now - clock);
    clock = now;
  };
  const consider = (r: RefineResult | null, method: AlignResult['method']) => {
    if (!r) return;
    attempts.push({ ...r, method });
    const candidate: AlignResult = { ...r, method, confident: isConfident(r, minNcc), attempts, timings };
    // Rank by coarse and fine correlation together: look-alike frames score
    // similarly when blurred but differ in their details.
    const rank = (x: AlignResult) => x.ncc + x.nccFine;
    if (!best || rank(candidate) > rank(best)) best = candidate;
  };

  if (options.seed) {
    if (options.lockScale) {
      // Trusted zoom: a free scale can drift at high magnification (blurry
      // upsampled reference vs sharp live view); refine the position only.
      const locked = refine(refP, liveP, options.seed, coarse, 0, true);
      consider(locked, 'refine');
      lap('locked');
      if (best && (best as AlignResult).confident) return best;
      // Confirming an exact prediction needs less evidence than finding the area.
      if (locked && isConfident(locked, LOCKED_MIN_NCC)) {
        return { ...locked, method: 'refine', confident: true, attempts, timings };
      }
    }
    // Check the seed at a mid level first; finish at full resolution only if it holds.
    const mid1 = Math.min(1, refP.images.length - 1, liveP.images.length - 1);
    const coarseFit = refine(refP, liveP, options.seed, coarse, mid1);
    if (coarseFit && coarseFit.ncc >= minNcc) consider(refine(refP, liveP, coarseFit.transform, mid1, 0), 'refine');
    lap('seed');
    if (best && (best as AlignResult).confident) return best;
  }

  const hint = options.scaleHint ?? options.seed?.s ?? null;
  const { width, height } = refP.images[0]!;
  const candidates: SearchCandidate[] = [];
  if (hint && hint > 0) {
    // ~100 px wide keeps each FFT at 256²; finer when the reference appears small (zoomed out).
    const level = searchLevel(refP, liveP, hint);
    // A small template tolerates a larger scale error (refinement fixes the
    // rest): step so the scale error stays within ~1.25 px at its edges.
    const templateWidth = (maskWidth(refP) * hint) / 2 ** level;
    const step = Math.min(0.08, Math.max(0.02, 2.5 / templateWidth));
    const halfSteps = Math.max(1, Math.min(5, Math.ceil((options.scaleTolerance ?? 0.1) / step)));
    candidates.push(...distinctCandidates(searchScales(refP, liveP, level, logRange(hint, halfSteps, step)), 8, width, height));
    lap(`search×${halfSteps * 2 + 1}@L${level}`);
  }
  if (!candidates.some((c) => c.ncc >= 0.6)) {
    // Broad sweep over 1/5×…5× at a coarse level.
    const level = levelForWidth(liveP, 72);
    const broad = logRange(1, 32, 0.05);
    candidates.push(...distinctCandidates(searchScales(refP, liveP, level, broad, 0.12, 3), 8, width, height));
    lap('broad');
  }
  // Successive halving: refine all candidates coarsely, the best three at a
  // mid level, and only the winner at full resolution.
  const top = Math.min(coarse + 1, refP.images.length - 1, liveP.images.length - 1);
  const mid = Math.min(1, top);
  const level2 = Math.min(2, top);
  const byScore = (a: RefineResult, b: RefineResult) => b.ncc + b.nccFine - (a.ncc + a.nccFine);
  const coarseFits = candidates
    .map((c) => refine(refP, liveP, c.transform, top, level2))
    .filter((r): r is RefineResult => r !== null)
    .sort(byScore);
  lap(`coarse×${candidates.length}`);
  const midFits = coarseFits
    .slice(0, 3)
    .map((r) => refine(refP, liveP, r.transform, level2, mid))
    .filter((r): r is RefineResult => r !== null)
    .sort(byScore);
  lap('mid×3');
  if (midFits[0]) consider(refine(refP, liveP, midFits[0].transform, mid, 0), 'search');
  lap('final');
  return best;
}

/** Usable-everywhere mask for an image. */
export function fullMask(image: GrayImage): Mask {
  return createMask(image.width, image.height, 1);
}
