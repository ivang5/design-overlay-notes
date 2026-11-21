/**
 * Rasterise where our own marks are drawn on screen, so view alignment can
 * ignore those pixels (the live screenshot is taken with the overlay visible
 * to avoid flicker). Runs wherever OffscreenCanvas exists (service worker).
 */
import { annotationBounds, arrowHeadLength, smoothPath } from '../editor/geometry';
import type { TextMeasurer } from '../editor/text-layout';
import type { Annotation } from '../shared/schemas';
import type { ViewTransform } from '../shared/view-transform';
import type { Mask } from './image';

/** Extra margin around every mark, in screen CSS px (anti-aliasing, selection outline). */
const MARGIN = 6;

/**
 * Clear mask pixels covered by `annotations` drawn with `view`.
 * `scale` converts live CSS px to mask pixels.
 */
export function clearInk(
  mask: Mask,
  annotations: readonly Annotation[],
  view: ViewTransform,
  scale: number,
  measure: TextMeasurer,
): void {
  if (annotations.length === 0 || typeof OffscreenCanvas === 'undefined') return;
  const canvas = new OffscreenCanvas(mask.width, mask.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const k = scale * view.s;
  ctx.setTransform(k, 0, 0, k, view.tx * scale, view.ty * scale);
  ctx.strokeStyle = '#000';
  ctx.fillStyle = '#000';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const margin = (MARGIN * 2) / view.s; // capture px

  for (const a of annotations) {
    switch (a.type) {
      case 'stroke':
      case 'highlighter':
        ctx.lineWidth = a.style.width + margin;
        ctx.stroke(new Path2D(smoothPath(a.geometry.points)));
        break;
      case 'arrow': {
        const g = a.geometry;
        ctx.lineWidth = Math.max(a.style.width, arrowHeadLength(a.style.width)) + margin;
        ctx.beginPath();
        ctx.moveTo(g.x1, g.y1);
        ctx.lineTo(g.x2, g.y2);
        ctx.stroke();
        break;
      }
      case 'rectangle':
      case 'ellipse': {
        const g = a.geometry;
        ctx.lineWidth = a.style.width + margin;
        ctx.beginPath();
        if (a.type === 'rectangle') ctx.rect(g.x, g.y, g.width, g.height);
        else ctx.ellipse(g.x + g.width / 2, g.y + g.height / 2, g.width / 2, g.height / 2, 0, 0, Math.PI * 2);
        ctx.stroke();
        break;
      }
      case 'text':
      case 'sticky-note': {
        const b = annotationBounds(a, measure);
        const m = margin / 2;
        ctx.fillRect(b.x - m, b.y - m, b.width + margin, b.height + margin);
        break;
      }
    }
  }
  const pixels = ctx.getImageData(0, 0, mask.width, mask.height).data;
  for (let i = 0, p = 3; i < mask.data.length; i++, p += 4) {
    if (pixels[p]! > 0) mask.data[i] = 0;
  }
}
