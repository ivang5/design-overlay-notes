/**
 * Canonical coordinate system
 * ===========================
 *
 * All annotation geometry is stored in **capture CSS pixels**: CSS pixels
 * relative to the top-left corner of the browser viewport at the moment the
 * capture was taken. A capture records:
 *
 *   viewportCssWidth × viewportCssHeight     (window.innerWidth/innerHeight)
 *   screenshotPixelWidth × screenshotPixelHeight  (natural size of the PNG)
 *
 * The screenshot scale is derived from those measured dimensions — NOT from
 * devicePixelRatio alone — because Windows display scaling, browser zoom and
 * fractional DPR values can make them disagree slightly.
 *
 * Why CSS pixels (and not normalized 0..1 coordinates)?
 *  - Pointer events deliver CSS pixels, so the live overlay needs no conversion.
 *  - Normalized coordinates distort shapes when the aspect ratio changes.
 *  - Rendering into the screenshot or a scaled preview is a single uniform
 *    scale via SVG viewBox = "0 0 viewportCssWidth viewportCssHeight".
 *
 * Every conversion between coordinate spaces must go through this module.
 */

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface CaptureGeometry {
  viewportCssWidth: number;
  viewportCssHeight: number;
  screenshotPixelWidth: number;
  screenshotPixelHeight: number;
  devicePixelRatio: number;
}

export interface ScreenshotTransform {
  /** Screenshot pixels per capture CSS pixel along x. */
  scaleX: number;
  /** Screenshot pixels per capture CSS pixel along y. */
  scaleY: number;
}

export function getScreenshotTransform(capture: CaptureGeometry): ScreenshotTransform {
  if (capture.viewportCssWidth <= 0 || capture.viewportCssHeight <= 0) {
    throw new Error('Capture has an invalid viewport size');
  }
  return {
    scaleX: capture.screenshotPixelWidth / capture.viewportCssWidth,
    scaleY: capture.screenshotPixelHeight / capture.viewportCssHeight,
  };
}

export function cssToScreenshot(point: Point, capture: CaptureGeometry): Point {
  const t = getScreenshotTransform(capture);
  return { x: point.x * t.scaleX, y: point.y * t.scaleY };
}

export function screenshotToCss(point: Point, capture: CaptureGeometry): Point {
  const t = getScreenshotTransform(capture);
  return { x: point.x / t.scaleX, y: point.y / t.scaleY };
}

/**
 * Fit a capture into a box while preserving aspect ratio.
 * Returns the CSS size to render the capture at and the uniform scale used.
 */
export function fitCaptureInto(capture: Size, box: Size): Size & { scale: number } {
  if (capture.width <= 0 || capture.height <= 0) return { width: 0, height: 0, scale: 1 };
  const scale = Math.min(box.width / capture.width, box.height / capture.height);
  const safe = Number.isFinite(scale) && scale > 0 ? scale : 1;
  return { width: capture.width * safe, height: capture.height * safe, scale: safe };
}

export interface LiveViewport {
  width: number;
  height: number;
  devicePixelRatio: number;
}

export type ViewportComparison =
  | { status: 'match' }
  | { status: 'mismatch'; reasons: string[] };

/** Tolerance (CSS px) for rounding differences between innerWidth readings. */
const SIZE_TOLERANCE = 2;

/**
 * Compare a capture's viewport with a live viewport. Marks drawn in capture CSS
 * pixels only line up 1:1 with the live page when the CSS viewport size and the
 * device pixel ratio (which includes browser zoom) are unchanged — and even
 * then only if the Figma canvas itself was not panned or zoomed, which the
 * extension cannot detect without relying on Figma internals.
 */
export function compareViewport(capture: CaptureGeometry, live: LiveViewport): ViewportComparison {
  const reasons: string[] = [];
  const dw = Math.abs(capture.viewportCssWidth - live.width);
  const dh = Math.abs(capture.viewportCssHeight - live.height);
  if (dw > SIZE_TOLERANCE || dh > SIZE_TOLERANCE) {
    reasons.push(
      `Viewport was ${Math.round(capture.viewportCssWidth)}×${Math.round(capture.viewportCssHeight)}, ` +
        `now ${Math.round(live.width)}×${Math.round(live.height)}`,
    );
  }
  if (Math.abs(capture.devicePixelRatio - live.devicePixelRatio) > 0.01) {
    reasons.push(
      `Zoom / pixel ratio was ${formatRatio(capture.devicePixelRatio)}, now ${formatRatio(live.devicePixelRatio)}`,
    );
  }
  return reasons.length === 0 ? { status: 'match' } : { status: 'mismatch', reasons };
}

function formatRatio(value: number): string {
  return `${Math.round(value * 100) / 100}x`;
}
