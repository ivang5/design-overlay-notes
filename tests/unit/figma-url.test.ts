import { describe, expect, it } from 'vitest';
import {
  cleanFigmaTitle,
  isSupportedPageUrl,
  parseFigmaUrl,
  projectKeyFor,
  sanitizePageUrl,
} from '../../src/shared/figma-url';

describe('parseFigmaUrl', () => {
  it('parses current /design/ URLs', () => {
    const parsed = parseFigmaUrl('https://www.figma.com/design/AbCdEf1234567890/Checkout-Flow?node-id=12-34&t=xyz');
    expect(parsed).toEqual({ kind: 'design', fileKey: 'AbCdEf1234567890', branchKey: null, slugName: 'Checkout Flow' });
  });

  it('parses legacy /file/ URLs', () => {
    expect(parseFigmaUrl('https://www.figma.com/file/AbCdEf1234567890/Old-File')?.kind).toBe('file');
  });

  it('parses prototype and FigJam board URLs', () => {
    expect(parseFigmaUrl('https://www.figma.com/proto/AbCdEf1234567890/Proto')?.kind).toBe('proto');
    expect(parseFigmaUrl('https://www.figma.com/board/AbCdEf1234567890/Board')?.kind).toBe('board');
  });

  it('parses branch URLs and gives branches their own project key', () => {
    const parsed = parseFigmaUrl('https://www.figma.com/design/AbCdEf1234567890/branch/BrAnCh12345678/Name');
    expect(parsed?.branchKey).toBe('BrAnCh12345678');
    expect(parsed?.slugName).toBe('Name');
    expect(projectKeyFor(parsed!)).toBe('AbCdEf1234567890/branch/BrAnCh12345678');
  });

  it('accepts URLs without a slug', () => {
    expect(parseFigmaUrl('https://www.figma.com/design/AbCdEf1234567890')?.slugName).toBeNull();
  });

  it('decodes percent-encoded slugs', () => {
    expect(parseFigmaUrl('https://www.figma.com/design/AbCdEf1234567890/Caf%C3%A9-Menu')?.slugName).toBe('Café Menu');
  });

  it.each([
    'https://www.figma.com/files/recents-and-sharing',
    'https://www.figma.com/',
    'https://figma.com/design/AbCdEf1234567890/x',
    'http://www.figma.com/design/AbCdEf1234567890/x',
    'https://www.figma.com.evil.com/design/AbCdEf1234567890/x',
    'https://evil.com/design/AbCdEf1234567890/x',
    'https://www.figma.com/design/short/x',
    'https://www.figma.com/design/bad$key$1234567/x',
    'http://127.0.0.1:5000/design/AbCdEf1234567890/x',
    'not a url',
    '',
    null,
    undefined,
  ])('rejects %s', (url) => {
    expect(parseFigmaUrl(url)).toBeNull();
    expect(isSupportedPageUrl(url)).toBe(false);
  });
});

describe('sanitizePageUrl', () => {
  it('keeps only node-id and drops fragments and tracking parameters', () => {
    expect(
      sanitizePageUrl('https://www.figma.com/design/AbCdEf1234567890/Name?node-id=1-2&t=TOKEN&fuid=123#frag'),
    ).toBe('https://www.figma.com/design/AbCdEf1234567890/Name?node-id=1-2');
  });

  it('removes the query entirely when nothing is kept', () => {
    expect(sanitizePageUrl('https://www.figma.com/design/AbCdEf1234567890/Name?t=abc')).toBe(
      'https://www.figma.com/design/AbCdEf1234567890/Name',
    );
  });

  it('returns null for invalid URLs', () => {
    expect(sanitizePageUrl('::nope')).toBeNull();
  });
});

describe('cleanFigmaTitle', () => {
  it('strips the " – Figma" suffix', () => {
    expect(cleanFigmaTitle('Checkout flow – Figma')).toBe('Checkout flow');
    expect(cleanFigmaTitle('Checkout flow - Figma')).toBe('Checkout flow');
  });

  it('keeps titles without the suffix and handles empty input', () => {
    expect(cleanFigmaTitle('Plain title')).toBe('Plain title');
    expect(cleanFigmaTitle('')).toBeNull();
    expect(cleanFigmaTitle(null)).toBeNull();
  });
});
