import { describe, expect, it } from 'vitest';
import {
  compareViewport,
  cssToScreenshot,
  fitCaptureInto,
  getScreenshotTransform,
  screenshotToCss,
  type CaptureGeometry,
} from '../../src/shared/coordinates';

const capture = (cssW: number, cssH: number, pxW: number, pxH: number, dpr: number): CaptureGeometry => ({
  viewportCssWidth: cssW,
  viewportCssHeight: cssH,
  screenshotPixelWidth: pxW,
  screenshotPixelHeight: pxH,
  devicePixelRatio: dpr,
});

describe('screenshot transform', () => {
  it.each([
    ['100% scaling', capture(1440, 900, 1440, 900, 1), 1],
    ['125% Windows scaling', capture(1536, 864, 1920, 1080, 1.25), 1.25],
    ['150% scaling', capture(1280, 720, 1920, 1080, 1.5), 1.5],
    ['Retina 2x', capture(1512, 945, 3024, 1890, 2), 2],
  ])('derives scale from measured sizes (%s)', (_name, geometry, expected) => {
    const t = getScreenshotTransform(geometry);
    expect(t.scaleX).toBeCloseTo(expected, 6);
    expect(t.scaleY).toBeCloseTo(expected, 6);
  });

  it('uses measured dimensions even when DPR disagrees (fractional scaling rounding)', () => {
    // 1.1x browser zoom on 1x display: innerWidth is rounded, screenshot is not exactly dpr * css.
    const geometry = capture(1745, 873, 1920, 960, 1.1);
    const t = getScreenshotTransform(geometry);
    expect(t.scaleX).toBeCloseTo(1920 / 1745, 9);
    expect(t.scaleY).toBeCloseTo(960 / 873, 9);
  });

  it('round-trips css -> screenshot -> css', () => {
    const geometry = capture(1536, 864, 1920, 1080, 1.25);
    for (const p of [
      { x: 0, y: 0 },
      { x: 100.5, y: 33.25 },
      { x: 1536, y: 864 },
    ]) {
      const back = screenshotToCss(cssToScreenshot(p, geometry), geometry);
      expect(back.x).toBeCloseTo(p.x, 9);
      expect(back.y).toBeCloseTo(p.y, 9);
    }
  });

  it('rejects an invalid viewport', () => {
    expect(() => getScreenshotTransform(capture(0, 900, 100, 100, 1))).toThrow();
  });
});

describe('fitCaptureInto', () => {
  it('preserves aspect ratio', () => {
    const fit = fitCaptureInto({ width: 1600, height: 900 }, { width: 800, height: 800 });
    expect(fit.scale).toBeCloseTo(0.5);
    expect(fit.width).toBeCloseTo(800);
    expect(fit.height).toBeCloseTo(450);
  });

  it('handles empty sizes', () => {
    expect(fitCaptureInto({ width: 0, height: 0 }, { width: 100, height: 100 }).scale).toBe(1);
  });
});

describe('compareViewport', () => {
  const geometry = capture(1440, 900, 2880, 1800, 2);

  it('matches the same viewport (with rounding tolerance)', () => {
    expect(compareViewport(geometry, { width: 1441, height: 899, devicePixelRatio: 2 }).status).toBe('match');
  });

  it('flags a narrower viewport (e.g. side panel opened)', () => {
    const result = compareViewport(geometry, { width: 1080, height: 900, devicePixelRatio: 2 });
    expect(result.status).toBe('mismatch');
    if (result.status === 'mismatch') expect(result.reasons[0]).toContain('1440×900');
  });

  it('flags a browser zoom change', () => {
    const result = compareViewport(geometry, { width: 1440, height: 900, devicePixelRatio: 2.5 });
    expect(result.status).toBe('mismatch');
  });
});
