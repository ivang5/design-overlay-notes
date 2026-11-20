import { createElement, memo, type ReactElement } from 'react';
import type { Annotation } from '../shared/schemas';
import { describeAnnotation, type SvgNode } from './render-model';
import type { TextMeasurer } from './text-layout';

const ATTR_RENAMES: Record<string, string> = {
  'xml:space': 'xmlSpace',
  class: 'className',
};

/** Convert an SVG attribute name to the React prop name. */
export function toReactPropName(name: string): string {
  const renamed = ATTR_RENAMES[name];
  if (renamed) return renamed;
  if (name.startsWith('data-') || name.startsWith('aria-')) return name;
  return name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

export function svgNodeToReact(node: SvgNode, key?: string | number): ReactElement {
  const props: Record<string, unknown> = { key };
  for (const [name, value] of Object.entries(node.attrs)) props[toReactPropName(name)] = value;
  const children: (ReactElement | string)[] = [];
  if (node.text !== undefined) children.push(node.text);
  node.children?.forEach((child, i) => children.push(svgNodeToReact(child, i)));
  return createElement(node.tag, props, ...children);
}

interface AnnotationLayerProps {
  annotations: readonly Annotation[];
  /** Annotations hidden while being edited, moved or erased (shown via the draft layer). */
  hiddenIds: ReadonlySet<string>;
  measure: TextMeasurer;
}

const AnnotationShape = memo(function AnnotationShape({
  annotation,
  measure,
}: {
  annotation: Annotation;
  measure: TextMeasurer;
}) {
  return svgNodeToReact(describeAnnotation(annotation, measure));
});

export const AnnotationLayer = memo(function AnnotationLayer({
  annotations,
  hiddenIds,
  measure,
}: AnnotationLayerProps) {
  return (
    <g className="don-annotations">
      {annotations.map((annotation) =>
        hiddenIds.has(annotation.id) ? null : (
          <AnnotationShape key={annotation.id} annotation={annotation} measure={measure} />
        ),
      )}
    </g>
  );
});
