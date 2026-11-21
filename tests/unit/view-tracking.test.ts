import { describe, expect, it } from 'vitest';
import { figmaWheelZoom } from '../../src/content/view-tracker';
import { decodeRegionGrid, encodeRegionGrid, regionGridCoverage } from '../../src/shared/region-grid';
import {
  IDENTITY_TRANSFORM,
  applyTransform,
  transformDistance,
  translateView,
  viewBoxFor,
  zoomViewAbout,
} from '../../src/shared/view-transform';

describe('view transform', () => {
  it('composes pans and zooms around a point', () => {
    let t = translateView(IDENTITY_TRANSFORM, 30, -20);
    expect(applyTransform(t, 10, 10)).toEqual({ x: 40, y: -10 });
    t = zoomViewAbout(t, 2, 100, 100);
    // The point under the zoom centre stays put.
    const before = applyTransform(translateView(IDENTITY_TRANSFORM, 30, -20), 70, 120);
    expect(before).toEqual({ x: 100, y: 100 });
    expect(applyTransform(t, 70, 120)).toEqual({ x: 100, y: 100 });
    expect(t.s).toBe(2);
  });

  it('maps the live viewport back to capture pixels for the SVG viewBox', () => {
    expect(viewBoxFor({ s: 2, tx: 100, ty: -50 }, 800, 600)).toBe('-50 25 400 300');
    expect(viewBoxFor(IDENTITY_TRANSFORM, 800, 600)).toBe('0 0 800 600');
  });

  it('measures the on-screen distance between transforms', () => {
    expect(transformDistance(IDENTITY_TRANSFORM, { s: 1, tx: 3, ty: 4 }, 100, 100)).toBeCloseTo(5);
    expect(transformDistance(IDENTITY_TRANSFORM, { s: 1.1, tx: 0, ty: 0 }, 100, 100)).toBeCloseTo(Math.hypot(10, 10));
  });
});

describe('Ctrl+wheel zoom prediction', () => {
  it('matches the factors measured on Figma (per wheel event)', () => {
    // [deltaY, measured factor] from repeated events at 100 % zoom.
    for (const [dy, factor] of [
      [1, 0.99505],
      [4, 0.98018],
      [16, 0.92371],
      [30, 0.86191],
      [100, 0.79896],
      [200, 0.75498],
      [400, 0.7],
      [-10, 1.05135],
      [-100, 1.25146],
    ] as const) {
      expect(Math.abs(figmaWheelZoom(dy) / factor - 1)).toBeLessThan(0.004);
    }
    expect(figmaWheelZoom(0)).toBe(1);
  });
});

describe('region grid', () => {
  it('round-trips the canvas cells', () => {
    const grid = encodeRegionGrid(16, 10, 7, (c, r) => c >= 2 && c < 8 && r < 6);
    const cells = decodeRegionGrid(grid)!;
    expect(cells).toHaveLength(70);
    expect(cells[0 * 10 + 2]).toBe(1);
    expect(cells[0 * 10 + 1]).toBe(0);
    expect(cells[6 * 10 + 4]).toBe(0);
    expect(regionGridCoverage(grid)).toBeCloseTo(36 / 70);
  });

  it('rejects malformed data', () => {
    expect(decodeRegionGrid({ cell: 16, cols: 100, rows: 100, bits: 'AA==' })).toBeNull();
    expect(decodeRegionGrid({ cell: 16, cols: 1, rows: 1, bits: '%%%' })).toBeNull();
  });
});
