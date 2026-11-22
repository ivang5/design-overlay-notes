/** Side panel / review page actions that touch storage, then notify others. */
import { forgetCaptureTargetsFor, setCaptureTarget } from '../database/capture-targets';
import {
  createProject,
  deleteAllData,
  deleteCapture,
  deleteProject,
  duplicateCapture,
  getAnnotations,
  getCaptureImages,
  listCaptures,
  moveCapture,
  renameProject,
  updateCaptureMeta,
  type CaptureMetaPatch,
} from '../database/repository';
import { captureExportName, downloadBlob, renderAnnotatedPng } from '../export/png-export';
import { broadcastDataChange, sendToBackground, type OpenInFigmaResult } from '../shared/messages';
import type { Capture, Project } from '../shared/schemas';

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

/** Create a project; with `projectKey`, new captures of that Figma file go to it from now on. */
export async function addProject(name: string, projectKey: string | null): Promise<Project> {
  const project = await createProject(name);
  if (projectKey) await setCaptureTarget(projectKey, project.id);
  broadcastDataChange({ scope: 'projects', projectId: project.id });
  return project;
}

/** Where new captures of a Figma file go (null: the file's own project). */
export async function chooseCaptureTarget(projectKey: string, projectId: string | null): Promise<void> {
  await setCaptureTarget(projectKey, projectId);
}

export async function moveCaptureTo(captureId: string, projectId: string): Promise<void> {
  const moved = await moveCapture(captureId, projectId);
  broadcastDataChange({ scope: 'captures', captureId, projectId: moved.projectId });
}

export async function removeProject(projectId: string): Promise<void> {
  const captureIds = (await listCaptures()).filter((c) => c.projectId === projectId).map((c) => c.id);
  await deleteProject(projectId);
  await forgetCaptureTargetsFor(projectId);
  for (const captureId of captureIds) broadcastDataChange({ scope: 'capture-deleted', captureId });
  broadcastDataChange({ scope: 'projects', projectId });
}

export async function wipeEverything(): Promise<void> {
  await deleteAllData();
  await chrome.storage.local.clear();
  broadcastDataChange({ scope: 'all' });
}
