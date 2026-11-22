import { describe, expect, it } from 'vitest';
import { planFlight } from '../../src/content/flight';
import { transformDistance, translateView, zoomViewAbout, type ViewTransform } from '../../src/shared/view-transform';

/** Apply a plan the way Figma does: the pan first, then the zoom around c. */
function fly(start: ViewTransform, target: ViewTransform, c: { x: number; y: number }, zoomError = 1): ViewTransform {
  const plan = planFlight(start, target, c, false);
  const panned = translateView(start, plan.pan.x, plan.pan.y);
  return zoomViewAbout(panned, Math.exp(plan.lnZoom) * zoomError, c.x, c.y);
}

describe('flight to the captured view', () => {
  const c = { x: 988, y: 481 };
  const target: ViewTransform = { s: 1, tx: 0, ty: 0 };

  it('lands exactly on the target', () => {
    for (const start of [
      { s: 0.068, tx: 2638.8, ty: -1334 }, // zoomed far out, deep in the empty canvas
      { s: 3.2, tx: -9000, ty: 4200 }, // zoomed in somewhere else
      { s: 1, tx: 40, ty: -25 }, // a small offset: pan only
    ]) {
      expect(transformDistance(fly(start, target, c), target, 1920, 963)).toBeLessThan(1e-6);
    }
  });

  it('keeps the area in place when the zoom response is slightly off', () => {
    // A 1 % zoom error after zooming in 15× only scales around the canvas centre.
    const landed = fly({ s: 0.068, tx: 2638.8, ty: -1334 }, target, c, 1.01);
    const centre = { x: landed.s * c.x + landed.tx, y: landed.s * c.y + landed.ty };
    expect(Math.hypot(centre.x - c.x, centre.y - c.y)).toBeLessThan(1e-6);
  });

  it('uses a short hop for corrections and nothing when already there', () => {
    const hop = planFlight({ s: 1, tx: 3, ty: -2 }, target, c, true);
    expect(hop.panFrames + hop.zoomFrames).toBeLessThanOrEqual(4);
    const none = planFlight(target, target, c, false);
    expect(none.panFrames + none.zoomFrames).toBe(0);
  });
});
