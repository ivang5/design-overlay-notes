/**
 * Imperative renderer for the in-progress draft (stroke being drawn, shape
 * being dragged). Updating a single DOM node per pointer move avoids
 * re-rendering React for every event.
 */
import type { Annotation } from '../shared/schemas';
import { describeAnnotation, type SvgNode } from './render-model';
import type { TextMeasurer } from './text-layout';

const SVG_NS = 'http://www.w3.org/2000/svg';
const XML_NS = 'http://www.w3.org/XML/1998/namespace';

function buildElement(node: SvgNode, doc: Document): SVGElement {
  const el = doc.createElementNS(SVG_NS, node.tag);
  for (const [name, value] of Object.entries(node.attrs)) {
    if (name === 'xml:space') el.setAttributeNS(XML_NS, 'xml:space', String(value));
    else el.setAttribute(name, String(value));
  }
  if (node.text !== undefined) el.textContent = node.text;
  for (const child of node.children ?? []) el.appendChild(buildElement(child, doc));
  return el;
}

export class DraftRenderer {
  private container: SVGGElement | null = null;

  constructor(private readonly measure: TextMeasurer) {}

  attach(container: SVGGElement | null): void {
    this.container = container;
  }

  render(draft: Annotation | null): void {
    const container = this.container;
    if (!container) return;
    if (!draft) {
      container.replaceChildren();
      return;
    }
    const node = describeAnnotation(draft, this.measure);
    container.replaceChildren(buildElement(node, container.ownerDocument));
  }
}
