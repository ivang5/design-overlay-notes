import { describe, expect, it } from 'vitest';
import { describeAnnotation } from '../../src/editor/render-model';
import { annotationsToSvgDocument, escapeXml, nodeToSvgString } from '../../src/editor/svg-string';
import { toReactPropName } from '../../src/editor/render-react';
import { estimateTextWidth, wrapText } from '../../src/editor/text-layout';
import { allTypes, sticky, text } from './fixtures';

// Monospace-like measurer: every character is 10px wide.
const mono = (s: string) => s.length * 10;

describe('wrapText', () => {
  it('wraps on spaces', () => {
    expect(wrapText('aaa bbb ccc', 10, 70, mono)).toEqual(['aaa bbb', 'ccc']);
  });

  it('keeps explicit newlines and empty lines', () => {
    expect(wrapText('one\n\ntwo', 10, 1000, mono)).toEqual(['one', '', 'two']);
  });

  it('hard-breaks words longer than the line', () => {
    expect(wrapText('abcdefghij', 10, 40, mono)).toEqual(['abcd', 'efgh', 'ij']);
  });

  it('drops whitespace at the start of wrapped lines', () => {
    expect(wrapText('aaaa    bbbb', 10, 50, mono)).toEqual(['aaaa', 'bbbb']);
  });
});

describe('render model', () => {
  it('describes every annotation type', () => {
    for (const annotation of allTypes()) {
      const node = describeAnnotation(annotation, estimateTextWidth);
      expect(node.attrs['data-annotation-id']).toBe(annotation.id);
    }
  });

  it('renders text with one tspan per line', () => {
    const node = describeAnnotation(text('t', 'line one\nline two'), estimateTextWidth);
    const textNode = node.children?.[0];
    expect(textNode?.tag).toBe('text');
    expect(textNode?.children?.map((c) => c.text)).toEqual(['line one', 'line two']);
  });

  it('keeps empty lines with a zero-width space', () => {
    const node = describeAnnotation(sticky('n', 'a\n\nb'), estimateTextWidth);
    const textNode = node.children?.find((c) => c.tag === 'text');
    expect(textNode?.children?.[1]?.text).toBe('​');
  });
});

describe('SVG serialization', () => {
  it('escapes user text so it cannot inject markup', () => {
    const svg = nodeToSvgString(describeAnnotation(text('t', '<script>alert("x")</script> & co'), estimateTextWidth));
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('&lt;script&gt;');
    expect(svg).toContain('&amp; co');
  });

  it('strips characters that are invalid in XML', () => {
    const svg = nodeToSvgString(describeAnnotation(text('t', 'bad\u0001char'), estimateTextWidth));
    expect(svg).toContain('badchar');
  });

  it('does not leak internal data attributes into exports', () => {
    const svg = annotationsToSvgDocument(
      allTypes(),
      { viewBoxWidth: 1440, viewBoxHeight: 900, pixelWidth: 2880, pixelHeight: 1800 },
      estimateTextWidth,
    );
    expect(svg).not.toContain('data-annotation-id');
    expect(svg).toContain('viewBox="0 0 1440 900"');
    expect(svg).toContain('width="2880"');
  });

  it('escapes all XML special characters', () => {
    expect(escapeXml(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&apos;');
  });
});

describe('React prop names', () => {
  it('converts SVG attribute names', () => {
    expect(toReactPropName('stroke-width')).toBe('strokeWidth');
    expect(toReactPropName('paint-order')).toBe('paintOrder');
    expect(toReactPropName('xml:space')).toBe('xmlSpace');
    expect(toReactPropName('data-annotation-id')).toBe('data-annotation-id');
  });
});
