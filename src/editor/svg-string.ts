/**
 * Serialize annotations to a standalone SVG document (used by PNG export and
 * available for a future SVG export).
 */
import type { Annotation } from '../shared/schemas';
import { describeAnnotation, type SvgNode } from './render-model';
import type { TextMeasurer } from './text-layout';

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Characters that are not allowed in XML 1.0 documents. */
// eslint-disable-next-line no-control-regex
const INVALID_XML_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;

function attrName(name: string): string {
  // Only our own fixed attribute names reach here, but stay defensive.
  return /^[a-zA-Z_:][-a-zA-Z0-9_:.]*$/.test(name) ? name : 'data-invalid';
}

export function nodeToSvgString(node: SvgNode): string {
  const attrs = Object.entries(node.attrs)
    .filter(([name]) => !name.startsWith('data-'))
    .map(([name, value]) => ` ${attrName(name)}="${escapeXml(String(value))}"`)
    .join('');
  const inner =
    (node.text !== undefined ? escapeXml(node.text.replace(INVALID_XML_CHARS, '')) : '') +
    (node.children ?? []).map(nodeToSvgString).join('');
  return `<${node.tag}${attrs}>${inner}</${node.tag}>`;
}

export interface SvgDocumentOptions {
  /** Coordinate space (capture CSS pixels). */
  viewBoxWidth: number;
  viewBoxHeight: number;
  /** Output size in pixels (e.g. the screenshot's natural size). */
  pixelWidth: number;
  pixelHeight: number;
}

export function annotationsToSvgDocument(
  annotations: readonly Annotation[],
  options: SvgDocumentOptions,
  measure: TextMeasurer,
): string {
  const body = annotations.map((a) => nodeToSvgString(describeAnnotation(a, measure))).join('');
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${options.pixelWidth}" height="${options.pixelHeight}" ` +
    `viewBox="0 0 ${options.viewBoxWidth} ${options.viewBoxHeight}">${body}</svg>`
  );
}
