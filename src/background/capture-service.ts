import { THUMBNAIL_WIDTH } from '../shared/constants';
import { dataUrlToBlob } from '../shared/binary';
import { cleanFigmaTitle, parseFigmaUrl, projectKeyFor, sanitizePageUrl } from '../shared/figma-url';
import type { Capture, ViewportMetadata } from '../shared/schemas';
import { createCapture } from '../database/repository';
import { getCaptureTargets } from '../database/capture-targets';
import { captureVisibleTabThrottled } from './capture-throttle';

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
  const dataUrl = await captureVisibleTabThrottled(windowId, { format: 'png' });
  const screenshot = dataUrlToBlob(dataUrl);

  const probe = await createImageBitmap(screenshot);
  const screenshotPixelWidth = probe.width;
  const screenshotPixelHeight = probe.height;
  probe.close();

  const thumbnail = await makeThumbnail(screenshot, screenshotPixelWidth, screenshotPixelHeight);
  const parsed = parseFigmaUrl(trustedPageUrl);
  const projectName = cleanFigmaTitle(metadata.pageTitle) ?? parsed?.slugName ?? 'Untitled Figma file';
  const projectKey = parsed ? projectKeyFor(parsed) : null;
  // The user may have chosen another project for this file's new captures.
  const projectId = projectKey ? ((await getCaptureTargets())[projectKey] ?? null) : null;

  return createCapture({
    metadata: { ...metadata, pageUrl: trustedPageUrl },
    pageUrl: sanitizePageUrl(trustedPageUrl) ?? '',
    projectKey,
    projectName,
    projectId,
    screenshot,
    thumbnail,
    screenshotPixelWidth,
    screenshotPixelHeight,
  });
}
