import type { Annotation, AnnotationStyle } from '../../src/shared/schemas';

export const CAPTURE_ID = 'capture1';
const style: AnnotationStyle = { color: '#e5322d', width: 4, opacity: 1 };
const base = (id: string) => ({ id, captureId: CAPTURE_ID, style, zIndex: 0, createdAt: 1, updatedAt: 1 });

export const stroke = (id = 's1', points = [10, 10, 50, 10, 90, 10]): Annotation => ({
  ...base(id),
  type: 'stroke',
  geometry: { points },
});

export const highlighter = (id = 'h1'): Annotation => ({
  ...base(id),
  type: 'highlighter',
  style: { color: '#f5c400', width: 20, opacity: 0.35 },
  geometry: { points: [0, 100, 200, 100] },
});

export const arrow = (id = 'a1'): Annotation => ({
  ...base(id),
  type: 'arrow',
  geometry: { x1: 0, y1: 0, x2: 100, y2: 100 },
});

export const rectangle = (id = 'r1'): Annotation => ({
  ...base(id),
  type: 'rectangle',
  geometry: { x: 100, y: 100, width: 200, height: 100 },
});

export const ellipse = (id = 'e1'): Annotation => ({
  ...base(id),
  type: 'ellipse',
  geometry: { x: 300, y: 300, width: 100, height: 50 },
});

export const text = (id = 't1', value = 'Check padding'): Annotation => ({
  ...base(id),
  type: 'text',
  style: { ...style, fontSize: 18 },
  geometry: { x: 500, y: 500, width: 280 },
  text: value,
});

export const sticky = (id = 'n1', value = 'Ask design about hover state'): Annotation => ({
  ...base(id),
  type: 'sticky-note',
  style: { ...style, fontSize: 14 },
  geometry: { x: 600, y: 50, width: 200 },
  text: value,
});

export const allTypes = (): Annotation[] => [
  stroke(),
  highlighter(),
  arrow(),
  rectangle(),
  ellipse(),
  text(),
  sticky(),
];
