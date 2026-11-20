/**
 * Text measurement and wrapping shared by the live overlay, review editor and
 * PNG export, so text wraps identically everywhere.
 */
import { FONT_FAMILY, LINE_HEIGHT } from '../shared/constants';

export type TextMeasurer = (text: string, fontSize: number, fontWeight?: number) => number;

let cachedMeasurer: TextMeasurer | null = null;

/** Canvas-based measurer (browser contexts); falls back to an estimate elsewhere (tests). */
export function getTextMeasurer(): TextMeasurer {
  if (cachedMeasurer) return cachedMeasurer;
  const ctx = createMeasureContext();
  if (!ctx) {
    cachedMeasurer = estimateTextWidth;
    return cachedMeasurer;
  }
  const cache = new Map<string, number>();
  cachedMeasurer = (text, fontSize, fontWeight = 400) => {
    const key = `${fontWeight}|${fontSize}|${text}`;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    ctx.font = `${fontWeight} ${fontSize}px ${FONT_FAMILY}`;
    const width = ctx.measureText(text).width;
    if (cache.size > 5_000) cache.clear();
    cache.set(key, width);
    return width;
  };
  return cachedMeasurer;
}

type Measure2D = Pick<CanvasRenderingContext2D, 'font' | 'measureText'>;

function createMeasureContext(): Measure2D | null {
  try {
    if (typeof OffscreenCanvas !== 'undefined') {
      const ctx = new OffscreenCanvas(1, 1).getContext('2d');
      if (ctx) return ctx;
    }
    if (typeof document !== 'undefined') {
      const ctx = document.createElement('canvas').getContext('2d');
      if (ctx) return ctx;
    }
  } catch {
    // fall through
  }
  return null;
}

/** Rough width estimate used where no canvas is available (unit tests). */
export const estimateTextWidth: TextMeasurer = (text, fontSize) => text.length * fontSize * 0.56;

export function lineHeightFor(fontSize: number): number {
  return fontSize * LINE_HEIGHT;
}

/**
 * Wrap text into lines no wider than maxWidth. Respects explicit newlines,
 * breaks on spaces, and hard-breaks words that are longer than a line.
 */
export function wrapText(
  text: string,
  fontSize: number,
  maxWidth: number,
  measure: TextMeasurer,
  fontWeight = 400,
): string[] {
  const lines: string[] = [];
  const width = (s: string) => measure(s, fontSize, fontWeight);
  for (const paragraph of text.split('\n')) {
    if (paragraph === '') {
      lines.push('');
      continue;
    }
    // Tokens alternate between words and runs of whitespace.
    const tokens = paragraph.split(/(\s+)/).filter((t) => t.length > 0);
    let current = '';
    for (const token of tokens) {
      if (width(current + token) <= maxWidth) {
        current += token;
        continue;
      }
      // Token does not fit on the current line: start a new one.
      if (current.trim() !== '') lines.push(current.trimEnd());
      current = '';
      if (/^\s+$/.test(token)) continue; // drop whitespace at the start of a line
      if (width(token) <= maxWidth) {
        current = token;
        continue;
      }
      // A single word wider than the line: hard-break it.
      const pieces = breakLongWord(token, maxWidth, width);
      lines.push(...pieces.slice(0, -1));
      current = pieces[pieces.length - 1] ?? '';
    }
    lines.push(current.trimEnd());
  }
  return lines;
}

function breakLongWord(word: string, maxWidth: number, width: (s: string) => number): string[] {
  const pieces: string[] = [];
  let current = '';
  for (const char of Array.from(word)) {
    if (current !== '' && width(current + char) > maxWidth) {
      pieces.push(current);
      current = char;
    } else {
      current += char;
    }
  }
  pieces.push(current);
  return pieces;
}

export interface TextBlockLayout {
  lines: string[];
  lineHeight: number;
  /** Width of the widest line. */
  contentWidth: number;
  contentHeight: number;
}

export function layoutTextBlock(
  text: string,
  fontSize: number,
  maxWidth: number,
  measure: TextMeasurer,
  fontWeight = 400,
): TextBlockLayout {
  const lines = wrapText(text, fontSize, maxWidth, measure, fontWeight);
  const lineHeight = lineHeightFor(fontSize);
  let contentWidth = 0;
  for (const line of lines) contentWidth = Math.max(contentWidth, measure(line, fontSize, fontWeight));
  return { lines, lineHeight, contentWidth, contentHeight: lines.length * lineHeight };
}
