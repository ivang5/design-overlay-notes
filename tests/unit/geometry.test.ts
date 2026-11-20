import { describe, expect, it } from 'vitest';
import {
  annotationBounds,
  distanceToSegment,
  hitTest,
  hitTestAnnotation,
  normalizeRect,
  resizeAnnotation,
  smoothPath,
  tint,
  translateAnnotation,
} from '../../src/editor/geometry';
import { estimateTextWidth } from '../../src/editor/text-layout';
import { arrow, ellipse, rectangle, sticky, stroke, text } from './fixtures';

const measure = estimateTextWidth;

describe('basic geometry', () => {
  it('normalizes rectangles dragged in any direction', () => {
    expect(normalizeRect(10, 20, 0, 5)).toEqual({ x: 0, y: 5, width: 10, height: 15 });
  });

  it('measures distance to a segment, clamped to its ends', () => {
    expect(distanceToSegment({ x: 5, y: 5 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBeCloseTo(5);
    expect(distanceToSegment({ x: -3, y: 4 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBeCloseTo(5);
  });

  it('builds a smooth path through freehand points', () => {
    expect(smoothPath([0, 0, 10, 10, 20, 0])).toMatch(/^M0 0Q10 10 15 5L20 0$/);
    expect(smoothPath([5, 5])).toMatch(/^M5 5L5\.01 5$/); // single dot
  });

  it('tints colors towards white', () => {
    expect(tint('#000000', 0.5)).toBe('#808080');
    expect(tint('#ffffff', 0.3)).toBe('#ffffff');
  });
});

describe('hit testing', () => {
  it('hits freehand strokes near the line only', () => {
    const s = stroke();
    expect(hitTestAnnotation(s, { x: 50, y: 12 }, 4, measure)).toBe(true);
    expect(hitTestAnnotation(s, { x: 50, y: 40 }, 4, measure)).toBe(false);
  });

  it('hits rectangles on their outline, not their interior', () => {
    const r = rectangle();
    expect(hitTestAnnotation(r, { x: 100, y: 150 }, 4, measure)).toBe(true);
    expect(hitTestAnnotation(r, { x: 200, y: 150 }, 4, measure)).toBe(false);
  });

  it('hits ellipses on their outline', () => {
    const e = ellipse();
    expect(hitTestAnnotation(e, { x: 300, y: 325 }, 4, measure)).toBe(true); // left edge
    expect(hitTestAnnotation(e, { x: 350, y: 325 }, 4, measure)).toBe(false); // centre
  });

  it('hits text boxes anywhere inside', () => {
    expect(hitTestAnnotation(text(), { x: 510, y: 510 }, 4, measure)).toBe(true);
    expect(hitTestAnnotation(sticky(), { x: 700, y: 80 }, 4, measure)).toBe(true);
  });

  it('returns the topmost annotation', () => {
    const lower = stroke('lower', [0, 0, 100, 0]);
    const upper = stroke('upper', [0, 0, 100, 0]);
    expect(hitTest([lower, upper], { x: 50, y: 0 }, 4, measure)?.id).toBe('upper');
    expect(hitTest([lower, upper], { x: 50, y: 50 }, 4, measure)).toBeNull();
  });
});

describe('transforms', () => {
  it('translates every annotation type', () => {
    const moved = translateAnnotation(stroke(), 5, -5);
    expect(moved.type === 'stroke' && moved.geometry.points).toEqual([15, 5, 55, 5, 95, 5]);
    const a = translateAnnotation(arrow(), 10, 10);
    expect(a.type === 'arrow' && a.geometry).toEqual({ x1: 10, y1: 10, x2: 110, y2: 110 });
    const r = translateAnnotation(rectangle(), 1, 2);
    expect(r.type === 'rectangle' && r.geometry).toMatchObject({ x: 101, y: 102, width: 200, height: 100 });
  });

  it('resizes boxes from the corner handle, normalizing negative sizes', () => {
    const r = resizeAnnotation(rectangle(), 'se', { x: 50, y: 50 });
    expect(r.type === 'rectangle' && r.geometry).toEqual({ x: 50, y: 50, width: 50, height: 50 });
  });

  it('moves arrow endpoints independently', () => {
    const a = resizeAnnotation(arrow(), 'start', { x: 20, y: 30 });
    expect(a.type === 'arrow' && a.geometry).toEqual({ x1: 20, y1: 30, x2: 100, y2: 100 });
  });

  it('resizes text wrap width with a minimum', () => {
    const t = resizeAnnotation(text(), 'se', { x: 510, y: 0 });
    expect(t.type === 'text' && t.geometry.width).toBe(40);
  });

  it('computes bounds that include stroke width', () => {
    const b = annotationBounds(rectangle(), measure);
    expect(b).toEqual({ x: 98, y: 98, width: 204, height: 104 });
  });
});
