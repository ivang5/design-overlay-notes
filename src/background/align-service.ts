/**
 * View alignment: where does a capture's area appear in the tab right now?
 *
 * Takes a fresh screenshot of the visible tab (kept in memory only, never
 * stored), and registers the capture's stored screenshot against it inside
 * the Figma canvas region. Everything runs locally in the service worker.
 */
import { clearMaskRect, countMask, createMask, grayFromRgba, type GrayImage, type Mask } from '../align/image';
import { clearInk } from '../align/ink-mask';
import { align, buildPyramid, type Pyramid } from '../align/register';
import { getTextMeasurer } from '../editor/text-layout';
import { getAnnotations, getCapture, getCaptureImages } from '../database/repository';
import { dataUrlToBlob } from '../shared/binary';
import type { ContentRequest, ViewAlignResult } from '../shared/messages';
import { decodeRegionGrid, type RegionGrid } from '../shared/region-grid';
import type { Capture } from '../shared/schemas';
import type { ViewTransform } from '../shared/view-transform';
import { captureVisibleTabThrottled } from './capture-throttle';
import { rememberView } from './overlay-registry';

/** Working resolution: image pixels per CSS pixel. */
const WORK_SCALE = 0.5;
/** Pixels next to non-canvas areas are ignored (UI borders and shadows). */
const ERODE_CSS_PX = 6;

type AlignRequest = Extract<ContentRequest, { type: 'VIEW_ALIGN' }>;

async function decodeGray(blob: Blob, width: number, height: number): Promise<GrayImage> {
  const bitmap = await createImageBitmap(blob, { resizeWidth: width, resizeHeight: height, resizeQuality: 'medium' });
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('2D canvas unavailable');
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  return grayFromRgba(ctx.getImageData(0, 0, width, height).data, width, height);
}

/** Region grid (CSS cells) → mask at working resolution, eroded at the borders. */
function maskFromGrid(grid: RegionGrid | null | undefined, width: number, height: number): Mask {
  const mask = createMask(width, height, 1);
  const cells = grid ? decodeRegionGrid(grid) : null;
  if (!grid || !cells) return mask;
  const cellPx = grid.cell * WORK_SCALE;
  for (let j = 0; j < height; j++) {
    const row = Math.floor((j + 0.5) / cellPx);
    for (let i = 0; i < width; i++) {
      const col = Math.floor((i + 0.5) / cellPx);
      const inside = row < grid.rows && col < grid.cols && cells[row * grid.cols + col] === 1;
      if (!inside) mask.data[j * width + i] = 0;
    }
  }
  return erode(mask, Math.max(1, Math.round(ERODE_CSS_PX * WORK_SCALE)));
}

/** Morphological erosion with a square window (separable min). */
function erode(mask: Mask, radius: number): Mask {
  const { width: w, height: h } = mask;
  const tmp = new Uint8Array(w * h);
  const out = createMask(w, h, 0);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      let v = 1;
      for (let k = -radius; k <= radius && v; k++) {
        const x = i + k;
        if (x < 0 || x >= w || !mask.data[j * w + x]) v = 0;
      }
      tmp[j * w + i] = v;
    }
  }
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      let v = 1;
      for (let k = -radius; k <= radius && v; k++) {
        const y = j + k;
        if (y < 0 || y >= h || !tmp[y * w + i]) v = 0;
      }
      out.data[j * w + i] = v;
    }
  }
  return out;
}

// The reference pyramid only depends on the stored screenshot (+ region), so
// cache the last few (alignment runs repeatedly for the capture on screen).
// Promises are cached so a pre-warm and a request don't decode twice.
const referenceCache = new Map<string, Promise<Pyramid>>();
const REFERENCE_CACHE_SIZE = 3;

function referencePyramid(capture: Capture, fallbackRegion: RegionGrid | null): Promise<Pyramid> {
  const region = capture.regionGrid ?? fallbackRegion;
  const key = `${capture.id}|${capture.regionGrid ? 'own' : (fallbackRegion?.bits.length ?? 'none')}`;
  const cached = referenceCache.get(key);
  if (cached) {
    referenceCache.delete(key);
    referenceCache.set(key, cached);
    return cached;
  }
  const pending = (async () => {
    const images = await getCaptureImages(capture.id);
    if (!images) throw new Error('Capture image not found');
    const width = Math.max(8, Math.round(capture.viewportCssWidth * WORK_SCALE));
    const height = Math.max(8, Math.round(capture.viewportCssHeight * WORK_SCALE));
    const gray = await decodeGray(images.screenshot, width, height);
    return buildPyramid(gray, maskFromGrid(region, width, height));
  })();
  referenceCache.set(key, pending);
  pending.catch(() => referenceCache.delete(key));
  while (referenceCache.size > REFERENCE_CACHE_SIZE) referenceCache.delete(referenceCache.keys().next().value!);
  return pending;
}

/**
 * Decode a capture's screenshot into the reference cache ahead of time (e.g.
 * when "Open in Figma" is clicked), so the first alignment doesn't wait for it.
 */
export async function prewarmReference(captureId: string): Promise<void> {
  const capture = await getCapture(captureId);
  if (capture?.regionGrid) await referencePyramid(capture, null);
}

const toWork = (t: ViewTransform): ViewTransform => ({ s: t.s, tx: t.tx * WORK_SCALE, ty: t.ty * WORK_SCALE });
const fromWork = (t: ViewTransform): ViewTransform => ({ s: t.s, tx: t.tx / WORK_SCALE, ty: t.ty / WORK_SCALE });

export async function alignView(tab: chrome.tabs.Tab, request: AlignRequest): Promise<ViewAlignResult> {
  if (!tab.active) return { status: 'unavailable', reason: 'The tab is not visible.' };
  const capture = await getCapture(request.captureId);
  if (!capture) return { status: 'unavailable', reason: 'Capture not found.' };

  const started = performance.now();
  // Same viewport layout → Figma's UI is in the same place; reuse the live region for old captures.
  const sameLayout =
    Math.abs(capture.viewportCssWidth - request.viewport.width) < 2 &&
    Math.abs(capture.viewportCssHeight - request.viewport.height) < 2;
  // Screenshot first (the view is what it is right now); prepare the reference meanwhile.
  const [refP, dataUrl] = await Promise.all([
    referencePyramid(capture, sameLayout ? request.region : null),
    captureVisibleTabThrottled(tab.windowId, { format: 'jpeg', quality: 85 }),
  ]);
  const captureMs = Math.round(performance.now() - started);
  const width = Math.max(8, Math.round(request.viewport.width * WORK_SCALE));
  const height = Math.max(8, Math.round(request.viewport.height * WORK_SCALE));
  const live = await decodeGray(dataUrlToBlob(dataUrl), width, height);
  const liveMask = maskFromGrid(request.region, width, height);
  const pad = 4;
  for (const r of request.exclude) {
    clearMaskRect(liveMask, (r.x - pad) * WORK_SCALE, (r.y - pad) * WORK_SCALE, (r.width + pad * 2) * WORK_SCALE, (r.height + pad * 2) * WORK_SCALE);
  }
  if (request.seed && request.inkVisible) {
    // Our marks are on screen at the seed position: ignore those pixels.
    clearInk(liveMask, await getAnnotations(capture.id), request.seed, WORK_SCALE, getTextMeasurer());
  }

  const prepMs = Math.round(performance.now() - started) - captureMs;
  if (__E2E__) {
    // Test builds keep the last inputs for offline analysis.
    (globalThis as { __alignDump?: unknown }).__alignDump = {
      ref: refP.images[0],
      refMask: refP.masks[0],
      live,
      liveMask,
      seed: request.seed ? toWork(request.seed) : null,
      hint: request.scaleHint,
    };
  }
  const result = align(refP, buildPyramid(live, liveMask), {
    seed: request.seed ? toWork(request.seed) : null,
    scaleHint: request.scaleHint,
    scaleTolerance: request.scaleTolerance,
    lockScale: request.lockScale,
    allowSearch: request.allowSearch,
  });
  if (__E2E__) {
    // Test builds keep a short log the e2e test can read.
    const log = ((globalThis as { __alignLog?: unknown[] }).__alignLog ??= []);
    log.push({
      ms: Math.round(performance.now() - started),
      ncc: result ? Math.round(result.ncc * 1000) / 1000 : null,
      method: result?.method ?? null,
      confident: result?.confident ?? false,
      seed: request.seed,
      hint: request.scaleHint,
      transform: result?.transform ? fromWork(result.transform) : null,
      attempts: result?.attempts.map((a) => ({
        method: a.method,
        ncc: Math.round(a.ncc * 1000) / 1000,
        fine: Math.round(a.nccFine * 1000) / 1000,
        valid: a.valid,
        std: Math.round(a.std * 10) / 10,
        t: fromWork(a.transform),
      })),
      liveMaskPx: countMask(liveMask),
      timings: result?.timings,
      stages: { capture: captureMs, prep: prepMs },
      refMaskPx: countMask(refP.masks[0]!),
    });
    if (log.length > 50) log.shift();
  }
  if (!result || !result.confident) return { status: 'not-found', ncc: result?.ncc ?? 0 };
  const transform = fromWork(result.transform);
  if (tab.id !== undefined) void rememberView(tab.id, capture.id, transform).catch(() => undefined);
  return { status: 'aligned', transform, ncc: result.ncc, method: result.method };
}
