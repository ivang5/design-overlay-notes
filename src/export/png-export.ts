/**
 * Annotated PNG export: base screenshot + annotation SVG rendered from the same
 * render model as the on-screen editor, at the screenshot's native resolution.
 * Never includes toolbars, selection handles or other transient UI.
 * Runs in extension pages only (needs DOM Image + canvas).
 */
import { annotationsToSvgDocument } from '../editor/svg-string';
import { getTextMeasurer } from '../editor/text-layout';
import type { Annotation, Capture } from '../shared/schemas';

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not render the annotation layer'));
    img.src = url;
  });
}

export async function renderAnnotatedPng(
  capture: Capture,
  screenshot: Blob,
  annotations: readonly Annotation[],
): Promise<Blob> {
  const width = capture.screenshotPixelWidth;
  const height = capture.screenshotPixelHeight;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas is not available');

  const base = await createImageBitmap(screenshot);
  ctx.drawImage(base, 0, 0, width, height);
  base.close();

  if (annotations.length > 0) {
    const svg = annotationsToSvgDocument(
      annotations,
      {
        viewBoxWidth: capture.viewportCssWidth,
        viewBoxHeight: capture.viewportCssHeight,
        pixelWidth: width,
        pixelHeight: height,
      },
      getTextMeasurer(),
    );
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    try {
      const layer = await loadImage(url);
      ctx.drawImage(layer, 0, 0, width, height);
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('PNG encoding failed'))), 'image/png');
  });
}

export function safeFileName(...parts: string[]): string {
  const base = parts
    .map((p) => p.normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-'))
    .filter(Boolean)
    .join('_')
    .slice(0, 120);
  return base || 'capture';
}

export function captureExportName(capture: Capture, extension: string): string {
  const stamp = new Date(capture.createdAt).toISOString().slice(0, 16).replace(/[:T]/g, '-');
  return `${safeFileName(capture.pageTitle ?? '', capture.title)}_${stamp}.${extension}`;
}

/** Save a blob through a temporary link (no `downloads` permission needed). */
export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
