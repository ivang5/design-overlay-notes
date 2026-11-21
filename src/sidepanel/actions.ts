/** Side panel / review page actions that touch storage, then notify others. */
import {
  deleteAllData,
  deleteCapture,
  deleteProject,
  duplicateCapture,
  getAnnotations,
  getCaptureImages,
  listCaptures,
  renameProject,
  updateCaptureMeta,
  type CaptureMetaPatch,
} from '../database/repository';
import { captureExportName, downloadBlob, renderAnnotatedPng } from '../export/png-export';
import { broadcastDataChange, sendToBackground, type OpenInFigmaResult } from '../shared/messages';
import type { Capture } from '../shared/schemas';

export function reviewUrl(captureId: string): string {
  return `${chrome.runtime.getURL('src/review/index.html')}?capture=${encodeURIComponent(captureId)}`;
}

export async function openReview(captureId: string): Promise<void> {
  await chrome.tabs.create({ url: reviewUrl(captureId) });
}

export async function exportCapturePng(capture: Capture): Promise<void> {
  const [images, annotations] = await Promise.all([getCaptureImages(capture.id), getAnnotations(capture.id)]);
  if (!images) throw new Error('Screenshot not found for this capture');
  const png = await renderAnnotatedPng(capture, images.screenshot, annotations);
  downloadBlob(png, captureExportName(capture, 'png'));
}

/** Put the annotated PNG on the clipboard (paste into chat, docs, tickets…). */
export async function copyCapturePng(capture: Capture): Promise<void> {
  const [images, annotations] = await Promise.all([getCaptureImages(capture.id), getAnnotations(capture.id)]);
  if (!images) throw new Error('Screenshot not found for this capture');
  // Pass a promise so the clipboard write starts within the click (user activation).
  const png = renderAnnotatedPng(capture, images.screenshot, annotations);
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
}

export async function openCaptureInFigma(captureId: string): Promise<OpenInFigmaResult> {
  const { id: windowId } = await chrome.windows.getCurrent();
  if (windowId === undefined) throw new Error('Window not found');
  return sendToBackground({ type: 'PANEL_OPEN_IN_FIGMA', windowId, captureId });
}

export async function saveCaptureMeta(captureId: string, patch: CaptureMetaPatch): Promise<Capture> {
  const updated = await updateCaptureMeta(captureId, patch);
  broadcastDataChange({ scope: 'captures', captureId, projectId: updated.projectId });
  return updated;
}

export async function removeCapture(captureId: string): Promise<void> {
  await deleteCapture(captureId);
  broadcastDataChange({ scope: 'capture-deleted', captureId });
}

export async function copyCapture(captureId: string): Promise<Capture> {
  const copy = await duplicateCapture(captureId);
  broadcastDataChange({ scope: 'captures', captureId: copy.id, projectId: copy.projectId });
  return copy;
}

export async function saveProjectName(projectId: string, name: string): Promise<void> {
  await renameProject(projectId, name);
  broadcastDataChange({ scope: 'projects', projectId });
}

export async function removeProject(projectId: string): Promise<void> {
  const captureIds = (await listCaptures()).filter((c) => c.projectId === projectId).map((c) => c.id);
  await deleteProject(projectId);
  for (const captureId of captureIds) broadcastDataChange({ scope: 'capture-deleted', captureId });
  broadcastDataChange({ scope: 'projects', projectId });
}

export async function wipeEverything(): Promise<void> {
  await deleteAllData();
  await chrome.storage.local.clear();
  broadcastDataChange({ scope: 'all' });
}
