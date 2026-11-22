/**
 * Planning of "go to the captured view" flights (pure geometry, unit-tested).
 */
import { applyTransform, invertTransform, type ViewTransform } from '../shared/view-transform';

export const smoothstep = (k: number) => k * k * (3 - 2 * k);

/**
 * A flight from the view `start` to `target`: pan by `pan` (live px) so the
 * point that ends up at the canvas centre `c` is there, then zoom around `c`
 * by e^lnZoom. Frame counts grow with the distance (a short hop for corrections).
 */
export function planFlight(
  start: ViewTransform,
  target: ViewTransform,
  c: { x: number; y: number },
  correction: boolean,
): { pan: { x: number; y: number }; lnZoom: number; panFrames: number; zoomFrames: number } {
  const anchor = applyTransform(invertTransform(target), c.x, c.y); // capture px shown at c in the end
  const now = applyTransform(start, anchor.x, anchor.y);
  const pan = { x: c.x - now.x, y: c.y - now.y };
  const lnZoom = Math.log(target.s / start.s);
  const distance = Math.hypot(pan.x, pan.y);
  const panFrames = distance < 0.01 ? 0 : correction ? 2 : Math.round(Math.min(12, 4 + 2 * Math.log2(1 + distance / 400)));
  const zoomFrames = Math.abs(lnZoom) < 1e-5 ? 0 : correction ? 2 : Math.round(Math.min(12, 4 + 3 * Math.abs(lnZoom)));
  return { pan, lnZoom, panFrames, zoomFrames };
}

