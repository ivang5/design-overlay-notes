/**
 * Pure geometry helpers: bounds, hit testing, transforms, path smoothing.
 * All values are in capture CSS pixels (see shared/coordinates.ts).
 */
import {
  STICKY_MIN_HEIGHT,
  STICKY_PADDING,
} from '../shared/constants';
import type { Point } from '../shared/coordinates';
import type { Annotation, TextLikeAnnotation } from '../shared/schemas';
import { layoutTextBlock, type TextBlockLayout, type TextMeasurer } from './text-layout';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function normalizeRect(x1: number, y1: number, x2: number, y2: number): Rect {
  return {
    x: Math.min(x1, x2),
    y: Math.min(y1, y2),
    width: Math.abs(x2 - x1),
    height: Math.abs(y2 - y1),
  };
}

export function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return distance(p, a);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq;
  t = Math.max(0, Math.min(1, t));
  return distance(p, { x: a.x + t * dx, y: a.y + t * dy });
}

/** Distance from a point to a polyline given as a flat [x0, y0, x1, y1, …] list. */
export function distanceToPolyline(p: Point, points: readonly number[]): number {
  if (points.length < 2) return Infinity;
  if (points.length < 4) return distance(p, { x: points[0]!, y: points[1]! });
  let min = Infinity;
  for (let i = 0; i + 3 < points.length; i += 2) {
    const d = distanceToSegment(
      p,
      { x: points[i]!, y: points[i + 1]! },
      { x: points[i + 2]!, y: points[i + 3]! },
    );
    if (d < min) min = d;
  }
  return min;
}

/**
 * Build a smooth SVG path through freehand points using quadratic curves
 * between segment midpoints. A single point renders as a dot.
 */
export function smoothPath(points: readonly number[]): string {
  const n = points.length / 2;
  if (n === 0) return '';
  const x = (i: number) => round1(points[i * 2]!);
  const y = (i: number) => round1(points[i * 2 + 1]!);
  if (n === 1) return `M${x(0)} ${y(0)}L${x(0) + 0.01} ${y(0)}`;
  if (n === 2) return `M${x(0)} ${y(0)}L${x(1)} ${y(1)}`;
  let d = `M${x(0)} ${y(0)}`;
  for (let i = 1; i < n - 1; i++) {
    const mx = round1((points[i * 2]! + points[(i + 1) * 2]!) / 2);
    const my = round1((points[i * 2 + 1]! + points[(i + 1) * 2 + 1]!) / 2);
    d += `Q${x(i)} ${y(i)} ${mx} ${my}`;
  }
  d += `L${x(n - 1)} ${y(n - 1)}`;
  return d;
}

/**
 * Fixed decoration sizes (arrow head minimum, corner radius, sticky padding…)
 * were designed for marks drawn at 100% view scale. Marks drawn on a zoomed-in
 * view are stored with smaller widths/font sizes; these factors shrink the
 * decorations with them while leaving marks of normal size unchanged.
 */
export function strokeDecorationScale(strokeWidth: number): number {
  return Math.min(1, strokeWidth / 2);
}

export function textDecorationScale(fontSize: number): number {
  return Math.min(1, fontSize / 14);
}

export function arrowHeadLength(strokeWidth: number): number {
  return Math.max(10 * strokeDecorationScale(strokeWidth), strokeWidth * 4);
}

/** Arrow head triangle for an arrow from (x1,y1) to (x2,y2). */
export function arrowHeadPoints(x1: number, y1: number, x2: number, y2: number, strokeWidth: number): Point[] {
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const length = arrowHeadLength(strokeWidth);
  const spread = Math.PI / 7;
  return [
    { x: x2, y: y2 },
    { x: x2 - length * Math.cos(angle - spread), y: y2 - length * Math.sin(angle - spread) },
    { x: x2 - length * Math.cos(angle + spread), y: y2 - length * Math.sin(angle + spread) },
  ];
}

/** Shaft end point, pulled back so the line does not poke through the arrow head tip. */
export function arrowShaftEnd(x1: number, y1: number, x2: number, y2: number, strokeWidth: number): Point {
  const len = Math.hypot(x2 - x1, y2 - y1);
  if (len === 0) return { x: x2, y: y2 };
  const pull = Math.min(len, arrowHeadLength(strokeWidth) * 0.6);
  return { x: x2 - ((x2 - x1) / len) * pull, y: y2 - ((y2 - y1) / len) * pull };
}

export interface TextBoxLayout extends TextBlockLayout {
  box: Rect;
  padding: number;
  fontSize: number;
}

export function fontSizeOf(annotation: TextLikeAnnotation): number {
  return annotation.style.fontSize ?? 18;
}

/** Layout of a text note or sticky note (wrapped lines + bounding box). */
export function layoutTextAnnotation(annotation: TextLikeAnnotation, measure: TextMeasurer): TextBoxLayout {
  const fontSize = fontSizeOf(annotation);
  const isSticky = annotation.type === 'sticky-note';
  const k = textDecorationScale(fontSize);
  const padding = isSticky ? STICKY_PADDING * k : 0;
  const innerWidth = Math.max(1, annotation.geometry.width - padding * 2);
  const block = layoutTextBlock(annotation.text, fontSize, innerWidth, measure, isSticky ? 500 : 600);
  const { x, y, width } = annotation.geometry;
  const box: Rect = isSticky
    ? { x, y, width, height: Math.max(STICKY_MIN_HEIGHT * k, block.contentHeight + padding * 2) }
    : // Plain text hugs its content so it does not create a huge invisible hit area.
      { x, y, width: Math.max(fontSize, block.contentWidth), height: Math.max(block.lineHeight, block.contentHeight) };
  return { ...block, box, padding, fontSize };
}

export function annotationBounds(annotation: Annotation, measure: TextMeasurer): Rect {
  switch (annotation.type) {
    case 'stroke':
    case 'highlighter': {
      const pts = annotation.geometry.points;
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (let i = 0; i + 1 < pts.length; i += 2) {
        minX = Math.min(minX, pts[i]!);
        maxX = Math.max(maxX, pts[i]!);
        minY = Math.min(minY, pts[i + 1]!);
        maxY = Math.max(maxY, pts[i + 1]!);
      }
      const pad = annotation.style.width / 2;
      return { x: minX - pad, y: minY - pad, width: maxX - minX + pad * 2, height: maxY - minY + pad * 2 };
    }
    case 'arrow': {
      const { x1, y1, x2, y2 } = annotation.geometry;
      const pad = arrowHeadLength(annotation.style.width);
      const r = normalizeRect(x1, y1, x2, y2);
      return { x: r.x - pad / 2, y: r.y - pad / 2, width: r.width + pad, height: r.height + pad };
    }
    case 'rectangle':
    case 'ellipse': {
      const pad = annotation.style.width / 2;
      const g = annotation.geometry;
      return { x: g.x - pad, y: g.y - pad, width: g.width + pad * 2, height: g.height + pad * 2 };
    }
    case 'text':
    case 'sticky-note':
      return layoutTextAnnotation(annotation, measure).box;
  }
}

function pointInRect(p: Point, r: Rect, pad = 0): boolean {
  return p.x >= r.x - pad && p.x <= r.x + r.width + pad && p.y >= r.y - pad && p.y <= r.y + r.height + pad;
}

/**
 * Is `p` on the annotation? Outlined shapes are hit near their outline only,
 * so a large rectangle does not swallow clicks on marks inside it.
 */
export function hitTestAnnotation(
  annotation: Annotation,
  p: Point,
  tolerance: number,
  measure: TextMeasurer,
): boolean {
  switch (annotation.type) {
    case 'stroke':
    case 'highlighter':
      return distanceToPolyline(p, annotation.geometry.points) <= annotation.style.width / 2 + tolerance;
    case 'arrow': {
      const { x1, y1, x2, y2 } = annotation.geometry;
      return (
        distanceToSegment(p, { x: x1, y: y1 }, { x: x2, y: y2 }) <=
        Math.max(annotation.style.width * 2, annotation.style.width / 2 + tolerance)
      );
    }
    case 'rectangle': {
      const { x, y, width, height } = annotation.geometry;
      const reach = annotation.style.width / 2 + tolerance;
      if (!pointInRect(p, { x, y, width, height }, reach)) return false;
      const inner = { x: x + reach, y: y + reach, width: width - reach * 2, height: height - reach * 2 };
      return inner.width <= 0 || inner.height <= 0 || !pointInRect(p, inner);
    }
    case 'ellipse': {
      const { x, y, width, height } = annotation.geometry;
      const rx = width / 2;
      const ry = height / 2;
      const reach = annotation.style.width / 2 + tolerance;
      if (rx < reach || ry < reach) return pointInRect(p, { x, y, width, height }, reach);
      const nx = (p.x - (x + rx)) / rx;
      const ny = (p.y - (y + ry)) / ry;
      const radial = Math.sqrt(nx * nx + ny * ny);
      return Math.abs(radial - 1) * Math.min(rx, ry) <= reach;
    }
    case 'text':
    case 'sticky-note':
      return pointInRect(p, layoutTextAnnotation(annotation, measure).box, tolerance / 2);
  }
}

/** Topmost annotation under the point (last in array = highest z-order). */
export function hitTest(
  annotations: readonly Annotation[],
  p: Point,
  tolerance: number,
  measure: TextMeasurer,
): Annotation | null {
  for (let i = annotations.length - 1; i >= 0; i--) {
    const annotation = annotations[i]!;
    if (hitTestAnnotation(annotation, p, tolerance, measure)) return annotation;
  }
  return null;
}

export function translateAnnotation<A extends Annotation>(annotation: A, dx: number, dy: number): A {
  switch (annotation.type) {
    case 'stroke':
    case 'highlighter': {
      const points = annotation.geometry.points.map((v, i) => round1(v + (i % 2 === 0 ? dx : dy)));
      return { ...annotation, geometry: { points } };
    }
    case 'arrow': {
      const g = annotation.geometry;
      return {
        ...annotation,
        geometry: { x1: round1(g.x1 + dx), y1: round1(g.y1 + dy), x2: round1(g.x2 + dx), y2: round1(g.y2 + dy) },
      };
    }
    case 'rectangle':
    case 'ellipse':
    case 'text':
    case 'sticky-note': {
      const g = annotation.geometry;
      return { ...annotation, geometry: { ...g, x: round1(g.x + dx), y: round1(g.y + dy) } };
    }
  }
}

export type CornerHandle = 'nw' | 'ne' | 'sw' | 'se';
export type ResizeHandle = 'start' | 'end' | CornerHandle;

const CORNERS: CornerHandle[] = ['nw', 'ne', 'sw', 'se'];

/** Handles offered for the selected annotation. */
export function resizeHandlesFor(annotation: Annotation): ResizeHandle[] {
  switch (annotation.type) {
    case 'arrow':
      return ['start', 'end'];
    case 'rectangle':
    case 'ellipse':
    case 'stroke':
    case 'highlighter':
      return CORNERS;
    case 'text':
    case 'sticky-note':
      return ['se'];
  }
}

/** Raw geometric box (without stroke padding) of a box-like or freehand annotation. */
function geometryBox(annotation: Annotation): { x0: number; y0: number; x1: number; y1: number } | null {
  switch (annotation.type) {
    case 'rectangle':
    case 'ellipse': {
      const g = annotation.geometry;
      return { x0: g.x, y0: g.y, x1: g.x + g.width, y1: g.y + g.height };
    }
    case 'stroke':
    case 'highlighter': {
      const pts = annotation.geometry.points;
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (let i = 0; i + 1 < pts.length; i += 2) {
        x0 = Math.min(x0, pts[i]!);
        x1 = Math.max(x1, pts[i]!);
        y0 = Math.min(y0, pts[i + 1]!);
        y1 = Math.max(y1, pts[i + 1]!);
      }
      return { x0, y0, x1, y1 };
    }
    default:
      return null;
  }
}

/**
 * Where a handle is drawn and hit-tested. Corner handles sit on the corners of
 * the selection outline (annotation bounds grown by `pad`).
 */
export function handlePosition(annotation: Annotation, handle: ResizeHandle, measure: TextMeasurer, pad = 0): Point {
  if (annotation.type === 'arrow') {
    const g = annotation.geometry;
    return handle === 'start' ? { x: g.x1, y: g.y1 } : { x: g.x2, y: g.y2 };
  }
  if (annotation.type === 'text' || annotation.type === 'sticky-note') {
    const box = layoutTextAnnotation(annotation, measure).box;
    // Text boxes resize their wrap width; the handle sits on the wrap edge.
    return { x: annotation.geometry.x + annotation.geometry.width, y: box.y + box.height };
  }
  const b = annotationBounds(annotation, measure);
  const west = handle === 'nw' || handle === 'sw';
  const north = handle === 'nw' || handle === 'ne';
  return {
    x: west ? b.x - pad : b.x + b.width + pad,
    y: north ? b.y - pad : b.y + b.height + pad,
  };
}

export interface ResizeOptions {
  /** Keep the width/height ratio (Shift). */
  keepAspect?: boolean;
  /** Smallest box edge, in annotation units, a corner drag may produce. */
  minSize?: number;
}

/** Signed scale factor for one axis, never collapsing a non-empty extent below `min`. */
function axisScale(extent: number, newExtent: number, min: number): number {
  if (extent === 0) return 1;
  let scale = newExtent / extent;
  if (Math.abs(scale * extent) < min) scale = (Math.sign(scale) || 1) * (min / Math.abs(extent));
  return scale;
}

/**
 * Apply a handle drag. `origin` is the annotation as it was when the drag
 * started and (dx, dy) how far the pointer has moved since then. The handle
 * follows the pointer; for corner handles the opposite corner stays fixed.
 */
export function resizeAnnotation<A extends Annotation>(
  origin: A,
  handle: ResizeHandle,
  dx: number,
  dy: number,
  options: ResizeOptions = {},
): A {
  if (origin.type === 'arrow') {
    const g = origin.geometry;
    const geometry =
      handle === 'start'
        ? { ...g, x1: round1(g.x1 + dx), y1: round1(g.y1 + dy) }
        : { ...g, x2: round1(g.x2 + dx), y2: round1(g.y2 + dy) };
    return { ...origin, geometry };
  }
  if (origin.type === 'text' || origin.type === 'sticky-note') {
    const g = origin.geometry;
    const min = Math.max(options.minSize ?? 40, 0.5);
    return { ...origin, geometry: { ...g, width: round1(Math.max(min, g.width + dx)) } };
  }

  const box = geometryBox(origin);
  if (!box || handle === 'start' || handle === 'end') return origin;
  const west = handle === 'nw' || handle === 'sw';
  const north = handle === 'nw' || handle === 'ne';
  // Fixed (opposite) corner and the dragged corner's new position.
  const fx = west ? box.x1 : box.x0;
  const fy = north ? box.y1 : box.y0;
  const mx = (west ? box.x0 : box.x1) + dx;
  const my = (north ? box.y0 : box.y1) + dy;
  const width = (west ? box.x0 : box.x1) - fx;
  const height = (north ? box.y0 : box.y1) - fy;
  const min = options.minSize ?? 2;
  let sx = axisScale(width, mx - fx, min);
  let sy = axisScale(height, my - fy, min);
  if (options.keepAspect && width !== 0 && height !== 0) {
    const magnitude = Math.max(Math.abs(sx), Math.abs(sy));
    sx = Math.sign(sx) * magnitude;
    sy = Math.sign(sy) * magnitude;
  }

  if (origin.type === 'stroke' || origin.type === 'highlighter') {
    const points = origin.geometry.points.map((v, i) => round1(i % 2 === 0 ? fx + (v - fx) * sx : fy + (v - fy) * sy));
    return { ...origin, geometry: { points } };
  }
  if (origin.type === 'rectangle' || origin.type === 'ellipse') {
    const r = normalizeRect(fx, fy, fx + width * sx, fy + height * sy);
    return {
      ...origin,
      geometry: { x: round1(r.x), y: round1(r.y), width: round1(r.width), height: round1(r.height) },
    };
  }
  return origin;
}

/** Lighten a #rrggbb color towards white (used for sticky note fills). */
export function tint(hex: string, amount: number): string {
  const n = Number.parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  const mix = (c: number) => Math.round(c + (255 - c) * amount);
  return `#${[mix(r), mix(g), mix(b)].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}
