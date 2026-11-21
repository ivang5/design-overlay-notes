import { describe, expect, it } from 'vitest';
import { fft2d, fftRealPair, ifftRealPair, mulConj } from '../../src/align/fft';
import { clearMaskRect, createImage, createMask, type GrayImage } from '../../src/align/image';
import { align, buildPyramid, refine, searchTranslation } from '../../src/align/register';
import { type ViewTransform } from '../../src/shared/view-transform';

// ---------------------------------------------------------------------------
// A synthetic "Figma canvas": grey background with white frames containing
// UI-like content, rendered at any pan/zoom (screen = s · scene + t).
// ---------------------------------------------------------------------------

type Shape =
  | { kind: 'rect'; x: number; y: number; w: number; h: number; v: number }
  | { kind: 'circle'; cx: number; cy: number; r: number; v: number };

function buildScene(seed = 7): Shape[] {
  let state = seed;
  const rand = () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
  const shapes: Shape[] = [];
  for (let f = 0; f < 6; f++) {
    const fx = 40 + (f % 3) * 260 + rand() * 30;
    const fy = 40 + Math.floor(f / 3) * 300 + rand() * 30;
    shapes.push({ kind: 'rect', x: fx, y: fy, w: 210, h: 250, v: 255 });
    // header bar, buttons, "text" lines, avatar circles
    shapes.push({ kind: 'rect', x: fx, y: fy, w: 210, h: 28, v: 40 + rand() * 60 });
    for (let k = 0; k < 7; k++) {
      shapes.push({ kind: 'rect', x: fx + 14, y: fy + 44 + k * 22, w: 60 + rand() * 120, h: 7, v: 60 + rand() * 80 });
    }
    shapes.push({ kind: 'rect', x: fx + 14, y: fy + 210, w: 80, h: 26, v: 30 + rand() * 120 });
    shapes.push({ kind: 'circle', cx: fx + 175, cy: fy + 70, r: 16 + rand() * 6, v: 90 + rand() * 100 });
  }
  return shapes;
}

const SCENE = buildScene();
const BACKGROUND = 229;

function sceneValue(x: number, y: number): number {
  let v = BACKGROUND;
  for (const s of SCENE) {
    if (s.kind === 'rect') {
      if (x >= s.x && x < s.x + s.w && y >= s.y && y < s.y + s.h) v = s.v;
    } else if ((x - s.cx) ** 2 + (y - s.cy) ** 2 <= s.r * s.r) {
      v = s.v;
    }
  }
  return v;
}

/** Render the scene as seen through `view` (2×2 supersampled). */
function render(view: ViewTransform, width: number, height: number): GrayImage {
  const img = createImage(width, height);
  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      let acc = 0;
      for (const [ox, oy] of [
        [0.25, 0.25],
        [0.75, 0.25],
        [0.25, 0.75],
        [0.75, 0.75],
      ] as const) {
        acc += sceneValue((i + ox - view.tx) / view.s, (j + oy - view.ty) / view.s);
      }
      img.data[j * width + i] = acc / 4;
    }
  }
  return img;
}

/** Transform mapping ref-view screen coordinates to live-view screen coordinates. */
function relative(ref: ViewTransform, live: ViewTransform): ViewTransform {
  const s = live.s / ref.s;
  return { s, tx: live.tx - s * ref.tx, ty: live.ty - s * ref.ty };
}

function expectClose(actual: ViewTransform, expected: ViewTransform, px = 0.75, w = 240, h = 200) {
  for (const [x, y] of [
    [0, 0],
    [w, 0],
    [0, h],
    [w, h],
  ] as const) {
    const dx = actual.s * x + actual.tx - (expected.s * x + expected.tx);
    const dy = actual.s * y + actual.ty - (expected.s * y + expected.ty);
    expect(Math.hypot(dx, dy)).toBeLessThan(px);
  }
}

const W = 240;
const H = 200;
const REF_VIEW: ViewTransform = { s: 0.5, tx: -60, ty: -40 };

describe('fft', () => {
  it('round-trips and correlates two real signals', () => {
    const n = 8;
    const a = new Float64Array(n * n);
    const b = new Float64Array(n * n);
    a[1 * n + 2] = 1; // impulse at (2, 1)
    b[0] = 1; // impulse at origin
    const [A, B] = fftRealPair(a, b, n);
    // corr(a, b)(d) = Σ a(x + d) b(x) → peak at d = (2, 1)
    const [corr, back] = ifftRealPair(mulConj(A, B), mulConj(B, B), n);
    expect(corr[1 * n + 2]).toBeCloseTo(1, 9);
    expect(back[0]).toBeCloseTo(1, 9);
    const re = Float64Array.from(a);
    const im = new Float64Array(n * n);
    fft2d(re, im, n);
    fft2d(re, im, n, true);
    expect(re[1 * n + 2]).toBeCloseTo(1, 9);
  });
});

describe('view alignment', () => {
  const ref = render(REF_VIEW, W, H);
  const refMask = createMask(W, H);
  const refP = buildPyramid(ref, refMask);

  it('finds a pure translation with masked cross-correlation', () => {
    const live = render({ ...REF_VIEW, tx: REF_VIEW.tx + 23, ty: REF_VIEW.ty - 17 }, W, H);
    const found = searchTranslation(ref, refMask, live, createMask(W, H), 2_000);
    expect(found).toMatchObject({ dx: 23, dy: -17 });
    expect(found!.ncc).toBeGreaterThan(0.95);
  });

  it('refines a slightly wrong prediction to sub-pixel accuracy', () => {
    const liveView = { s: REF_VIEW.s * 1.25, tx: -110, ty: -70 };
    const truth = relative(REF_VIEW, liveView);
    const live = render(liveView, W, H);
    const seed = { s: truth.s * 1.04, tx: truth.tx + 6, ty: truth.ty - 5 };
    const result = refine(refP, buildPyramid(live, createMask(W, H)), seed, 2);
    expect(result).not.toBeNull();
    expectClose(result!.transform, truth);
    expect(result!.ncc).toBeGreaterThan(0.95);
  });

  it('recovers zoom + pan from a zoom hint (no prediction)', () => {
    const liveView = { s: REF_VIEW.s * 1.6, tx: -150, ty: -60 };
    const truth = relative(REF_VIEW, liveView);
    const live = render(liveView, W, H);
    const result = align(refP, buildPyramid(live, createMask(W, H)), { scaleHint: 1.6 * 1.03 });
    expect(result?.confident).toBe(true);
    expectClose(result!.transform, truth, 1);
  });

  it('recovers a zoom-out without any hint', () => {
    const liveView = { s: REF_VIEW.s * 0.62, tx: -10, ty: 5 };
    const truth = relative(REF_VIEW, liveView);
    const live = render(liveView, W, H);
    const result = align(refP, buildPyramid(live, createMask(W, H)));
    expect(result?.confident).toBe(true);
    expectClose(result!.transform, truth, 1);
  });

  it('ignores masked-out static UI and our own marks', () => {
    const liveView = { s: REF_VIEW.s, tx: REF_VIEW.tx - 31, ty: REF_VIEW.ty + 12 };
    const truth = relative(REF_VIEW, liveView);
    const live = render(liveView, W, H);
    const liveRef = createImage(W, H);
    liveRef.data.set(ref.data);
    // Static "Figma panel" on the left in both images, a red mark in the live one.
    for (const img of [ref, live]) {
      for (let j = 0; j < H; j++) for (let i = 0; i < 40; i++) img.data[j * W + i] = (i * 7 + j * 3) % 255;
    }
    for (let j = 90; j < 100; j++) for (let i = 60; i < 220; i++) live.data[j * W + i] = 80;
    const refMaskUi = createMask(W, H);
    clearMaskRect(refMaskUi, 0, 0, 40, H);
    const liveMaskUi = createMask(W, H);
    clearMaskRect(liveMaskUi, 0, 0, 40, H);
    clearMaskRect(liveMaskUi, 56, 86, 168, 18);
    const result = align(buildPyramid(ref, refMaskUi), buildPyramid(live, liveMaskUi), {
      seed: { s: 1, tx: -25, ty: 10 },
    });
    expect(result?.confident).toBe(true);
    expectClose(result!.transform, truth);
    ref.data.set(liveRef.data); // restore for other tests
  });

  it('finds the area when the view is zoomed far out (area at 1/5 of its captured size)', () => {
    const liveView = { s: REF_VIEW.s * 0.2, tx: 70, ty: 60 };
    const truth = relative(REF_VIEW, liveView);
    const live = render(liveView, W, H);
    const result = align(refP, buildPyramid(live, createMask(W, H)), { scaleHint: 0.2 * 1.01, scaleTolerance: 0.03 });
    expect(result?.confident).toBe(true);
    expectClose(result!.transform, truth, 1.2);
  });

  it('confirms an exact prediction when zoomed far in (4×)', () => {
    const liveView = { s: REF_VIEW.s * 4, tx: -700, ty: -500 };
    const truth = relative(REF_VIEW, liveView);
    const live = render(liveView, W, H);
    const seed = { s: truth.s, tx: truth.tx + 3, ty: truth.ty - 2 };
    const result = align(refP, buildPyramid(live, createMask(W, H)), { seed, lockScale: true });
    expect(result?.confident).toBe(true);
    expectClose(result!.transform, truth, 1.5);
  });

  it('reports no confident match when the captured area is not in view', () => {
    const elsewhere = render({ s: 0.5, tx: -900, ty: -900 }, W, H); // empty canvas far away
    const result = align(refP, buildPyramid(elsewhere, createMask(W, H)), { seed: { s: 1, tx: 0, ty: 0 } });
    expect(result?.confident ?? false).toBe(false);
  });
});
