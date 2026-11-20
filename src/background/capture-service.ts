import { MIN_CAPTURE_INTERVAL_MS, THUMBNAIL_WIDTH } from '../shared/constants';
import { dataUrlToBlob } from '../shared/binary';
import { cleanFigmaTitle, parseFigmaUrl, projectKeyFor, sanitizePageUrl } from '../shared/figma-url';
import type { Capture, ViewportMetadata } from '../shared/schemas';
import { createCapture } from '../database/repository';

// Ephemeral by design: if the worker restarts, the worst case is that the
// next capture is not delayed, and Chrome's own rate limit still applies.
let lastCaptureAt = 0;

async function respectRateLimit(): Promise<void> {
  const wait = lastCaptureAt + MIN_CAPTURE_INTERVAL_MS - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastCaptureAt = Date.now();
}

async function makeThumbnail(screenshot: Blob, width: number, height: number): Promise<Blob | null> {
  try {
    const targetWidth = Math.min(THUMBNAIL_WIDTH, width);
    const targetHeight = Math.max(1, Math.round((height / width) * targetWidth));
    const bitmap = await createImageBitmap(screenshot, {
      resizeWidth: targetWidth,
      resizeHeight: targetHeight,
      resizeQuality: 'high',
    });
    const canvas = new OffscreenCanvas(targetWidth, targetHeight);
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    return await canvas.convertToBlob({ type: 'image/webp', quality: 0.82 });
  } catch (error) {
    console.warn('[overlay-notes] Thumbnail generation failed', error);
    return null;
  }
}

/**
 * Capture the visible area of the tab's window and store it as a new capture.
 * `trustedPageUrl` comes from Chrome (sender.url), not from the page.
 */
export async function captureTab(
  windowId: number,
  trustedPageUrl: string,
  metadata: ViewportMetadata,
): Promise<Capture> {
  await respectRateLimit();
  const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
  const screenshot = dataUrlToBlob(dataUrl);

  const probe = await createImageBitmap(screenshot);
  const screenshotPixelWidth = probe.width;
  const screenshotPixelHeight = probe.height;
  probe.close();

  const thumbnail = await makeThumbnail(screenshot, screenshotPixelWidth, screenshotPixelHeight);
  const parsed = parseFigmaUrl(trustedPageUrl);
  const projectName = cleanFigmaTitle(metadata.pageTitle) ?? parsed?.slugName ?? 'Untitled Figma file';

  return createCapture({
    metadata: { ...metadata, pageUrl: trustedPageUrl },
    pageUrl: sanitizePageUrl(trustedPageUrl) ?? '',
    projectKey: parsed ? projectKeyFor(parsed) : null,
    projectName,
    screenshot,
    thumbnail,
    screenshotPixelWidth,
    screenshotPixelHeight,
  });
}
