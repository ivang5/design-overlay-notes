/**
 * Single source of truth for how an annotation looks.
 *
 * `describeAnnotation` turns an annotation into a tiny, framework-free SVG
 * node tree. That tree is rendered three ways:
 *   - React elements for the live overlay and review editor (render-react.tsx)
 *   - imperative DOM for the in-progress draft while drawing (draft-renderer.ts)
 *   - an SVG string for PNG export (svg-string.ts)
 * so the exported PNG matches what the user saw on screen.
 */
import { FONT_FAMILY } from '../shared/constants';
import type { Annotation } from '../shared/schemas';
import {
  arrowHeadPoints,
  arrowShaftEnd,
  layoutTextAnnotation,
  round1,
  smoothPath,
  strokeDecorationScale,
  textDecorationScale,
  tint,
} from './geometry';
import type { TextMeasurer } from './text-layout';

export type SvgAttrValue = string | number;

export interface SvgNode {
  tag: 'g' | 'path' | 'rect' | 'ellipse' | 'line' | 'polygon' | 'text' | 'tspan';
  attrs: Record<string, SvgAttrValue>;
  children?: SvgNode[];
  text?: string;
}

const STICKY_TEXT_COLOR = '#1d1d1f';

export function describeAnnotation(annotation: Annotation, measure: TextMeasurer): SvgNode {
  const { style } = annotation;
  const common = { 'data-annotation-id': annotation.id };

  switch (annotation.type) {
    case 'stroke':
    case 'highlighter':
      return {
        tag: 'path',
        attrs: {
          ...common,
          d: smoothPath(annotation.geometry.points),
          fill: 'none',
          stroke: style.color,
          'stroke-width': style.width,
          'stroke-linecap': 'round',
          'stroke-linejoin': 'round',
          opacity: style.opacity,
        },
      };

    case 'arrow': {
      const { x1, y1, x2, y2 } = annotation.geometry;
      const end = arrowShaftEnd(x1, y1, x2, y2, style.width);
      const head = arrowHeadPoints(x1, y1, x2, y2, style.width)
        .map((p) => `${round1(p.x)},${round1(p.y)}`)
        .join(' ');
      return {
        tag: 'g',
        attrs: { ...common, opacity: style.opacity },
        children: [
          {
            tag: 'line',
            attrs: {
              x1,
              y1,
              x2: round1(end.x),
              y2: round1(end.y),
              stroke: style.color,
              'stroke-width': style.width,
              'stroke-linecap': 'round',
            },
          },
          {
            tag: 'polygon',
            attrs: {
              points: head,
              fill: style.color,
              stroke: style.color,
              'stroke-width': Math.max(strokeDecorationScale(style.width), style.width / 2),
              'stroke-linejoin': 'round',
            },
          },
        ],
      };
    }

    case 'rectangle': {
      const g = annotation.geometry;
      return {
        tag: 'rect',
        attrs: {
          ...common,
          x: g.x,
          y: g.y,
          width: g.width,
          height: g.height,
          rx: Math.min(4 * strokeDecorationScale(style.width), g.width / 4, g.height / 4),
          fill: 'none',
          stroke: style.color,
          'stroke-width': style.width,
          'stroke-linejoin': 'round',
          opacity: style.opacity,
        },
      };
    }

    case 'ellipse': {
      const g = annotation.geometry;
      return {
        tag: 'ellipse',
        attrs: {
          ...common,
          cx: round1(g.x + g.width / 2),
          cy: round1(g.y + g.height / 2),
          rx: round1(g.width / 2),
          ry: round1(g.height / 2),
          fill: 'none',
          stroke: style.color,
          'stroke-width': style.width,
          opacity: style.opacity,
        },
      };
    }

    case 'text': {
      const layout = layoutTextAnnotation(annotation, measure);
      return {
        tag: 'g',
        attrs: { ...common, opacity: style.opacity },
        children: [textNode(layout.lines, layout.box.x, layout.box.y, layout.fontSize, layout.lineHeight, {
          fill: style.color,
          'font-weight': 600,
          // White halo keeps notes legible on top of busy designs.
          stroke: '#ffffff',
          'stroke-width': Math.max(2 * Math.min(1, layout.fontSize / 12), layout.fontSize / 6),
          'stroke-linejoin': 'round',
          'paint-order': 'stroke',
        })],
      };
    }

    case 'sticky-note': {
      const layout = layoutTextAnnotation(annotation, measure);
      const { box, padding } = layout;
      const k = textDecorationScale(layout.fontSize);
      return {
        tag: 'g',
        attrs: { ...common, opacity: style.opacity },
        children: [
          // Soft offset "shadow" drawn with plain shapes so export matches the screen.
          {
            tag: 'rect',
            attrs: {
              x: round1(box.x + 2 * k),
              y: round1(box.y + 3 * k),
              width: box.width,
              height: box.height,
              rx: 4 * k,
              fill: '#000000',
              opacity: 0.12,
            },
          },
          {
            tag: 'rect',
            attrs: {
              x: box.x,
              y: box.y,
              width: box.width,
              height: box.height,
              rx: 4 * k,
              fill: tint(style.color, 0.78),
              stroke: style.color,
              'stroke-width': 1.5 * k,
            },
          },
          textNode(layout.lines, box.x + padding, box.y + padding, layout.fontSize, layout.lineHeight, {
            fill: STICKY_TEXT_COLOR,
            'font-weight': 500,
          }),
        ],
      };
    }
  }
}

function textNode(
  lines: string[],
  x: number,
  y: number,
  fontSize: number,
  lineHeight: number,
  extra: Record<string, SvgAttrValue>,
): SvgNode {
  // Baseline of the first line: roughly centred within its line box.
  const firstBaseline = y + (lineHeight + fontSize * 0.7) / 2;
  return {
    tag: 'text',
    attrs: {
      x: round1(x),
      y: round1(firstBaseline),
      'font-family': FONT_FAMILY,
      'font-size': fontSize,
      'xml:space': 'preserve',
      ...extra,
    },
    children: lines.map((line, i) => ({
      tag: 'tspan' as const,
      attrs: { x: round1(x), y: round1(firstBaseline + i * lineHeight) },
      // A zero-width space keeps empty lines from collapsing.
      text: line === '' ? '​' : line,
    })),
  };
}
