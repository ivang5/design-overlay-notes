/**
 * Mapping from capture CSS pixels to live viewport CSS pixels:
 *   live = s · capture + (tx, ty)
 *
 * Identity while Figma shows exactly the captured view. View tracking keeps
 * it up to date when the Figma canvas is panned or zoomed, so marks stay
 * attached to the design.
 */
export interface ViewTransform {
  s: number;
  tx: number;
  ty: number;
}

export const IDENTITY_TRANSFORM: ViewTransform = Object.freeze({ s: 1, tx: 0, ty: 0 });

export function isIdentity(t: ViewTransform, epsilon = 1e-3): boolean {
  return Math.abs(t.s - 1) < epsilon && Math.abs(t.tx) < 0.05 && Math.abs(t.ty) < 0.05;
}

export function applyTransform(t: ViewTransform, x: number, y: number): { x: number; y: number } {
  return { x: t.s * x + t.tx, y: t.s * y + t.ty };
}

/** a ∘ b: apply b, then a. */
export function composeTransforms(a: ViewTransform, b: ViewTransform): ViewTransform {
  return { s: a.s * b.s, tx: a.s * b.tx + a.tx, ty: a.s * b.ty + a.ty };
}

export function invertTransform(t: ViewTransform): ViewTransform {
  return { s: 1 / t.s, tx: -t.tx / t.s, ty: -t.ty / t.s };
}

/** View change "pan by (dx, dy)" as a transform to compose on the left. */
export function panDelta(dx: number, dy: number): ViewTransform {
  return { s: 1, tx: dx, ty: dy };
}

/** View change "zoom by factor around (cx, cy)" as a transform to compose on the left. */
export function zoomDelta(factor: number, cx: number, cy: number): ViewTransform {
  return { s: factor, tx: cx * (1 - factor), ty: cy * (1 - factor) };
}

/** The view moved by (dx, dy) live pixels (e.g. Figma panned). */
export function translateView(t: ViewTransform, dx: number, dy: number): ViewTransform {
  return { s: t.s, tx: t.tx + dx, ty: t.ty + dy };
}

/** The view zoomed by `factor` around the live point (cx, cy). */
export function zoomViewAbout(t: ViewTransform, factor: number, cx: number, cy: number): ViewTransform {
  return { s: t.s * factor, tx: cx + factor * (t.tx - cx), ty: cy + factor * (t.ty - cy) };
}

/** SVG viewBox (in capture pixels) that renders capture content at its live position. */
export function viewBoxFor(t: ViewTransform, liveWidth: number, liveHeight: number): string {
  const r = (v: number) => Math.round(v * 1000) / 1000;
  return `${r(-t.tx / t.s)} ${r(-t.ty / t.s)} ${r(liveWidth / t.s)} ${r(liveHeight / t.s)}`;
}

/** Largest on-screen distance between two transforms over a capture-sized area. */
export function transformDistance(a: ViewTransform, b: ViewTransform, width: number, height: number): number {
  let max = 0;
  for (const [x, y] of [
    [0, 0],
    [width, 0],
    [0, height],
    [width, height],
  ] as const) {
    const p = applyTransform(a, x, y);
    const q = applyTransform(b, x, y);
    max = Math.max(max, Math.hypot(p.x - q.x, p.y - q.y));
  }
  return max;
}
