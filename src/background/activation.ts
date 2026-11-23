/**
 * User-gesture entry points: toolbar icon, keyboard commands and side panel
 * actions that operate on a Figma tab.
 */
import { DEFAULT_SHORTCUTS } from '../shared/constants';
import { compareViewport } from '../shared/coordinates';
import { isSupportedPageUrl, parseFigmaUrl, projectKeyFor } from '../shared/figma-url';
import { errorMessage, type ShowOnPageResult } from '../shared/messages';
import { getCapture } from '../database/repository';
import { getSettings } from '../database/settings';
import { prewarmReference } from './align-service';
import { takePendingShow } from './open-in-figma';
import { ensureOverlay, pingTab, sendToTab } from './tab-bridge';

export const NO_ACCESS_MESSAGE =
  `Click the Design Overlay Notes icon (or press ${DEFAULT_SHORTCUTS.activate}) on your Figma tab first. ` +
  'Chrome only lets the extension see a tab after you invoke it there.';

/** Toolbar icon click / activate shortcut on a Figma tab. */
export async function activateOnTab(tab: chrome.tabs.Tab): Promise<void> {
  if (tab.id === undefined) return;
  if (!isSupportedPageUrl(tab.url)) throw new Error('This tab is not a Figma design file.');
  const status = await ensureOverlay(tab.id);
  // "Open in Figma" from the notes manager is waiting for this click.
  const pending = await takePendingShow(tab.id);
  if (pending) {
    await sendToTab(tab.id, { type: 'SHOW_CAPTURE', captureId: pending, goToView: true });
    return;
  }
  // Closed: just the toolbar (the capture is taken when you start annotating).
  // Open: start/stop drawing (taking the capture first if there is none yet).
  await sendToTab(tab.id, { type: status.mode === 'closed' ? 'OPEN_TOOLBAR' : 'TOGGLE_ANNOTATE' });
}

export async function newCaptureOnTab(tab: chrome.tabs.Tab): Promise<string> {
  if (tab.id === undefined) throw new Error('No active tab');
  if (!tab.url) throw new Error(NO_ACCESS_MESSAGE);
  if (!isSupportedPageUrl(tab.url)) throw new Error('The active tab is not a Figma design file.');
  await ensureOverlay(tab.id);
  const { captureId } = await sendToTab(tab.id, { type: 'CAPTURE_START' });
  return captureId;
}

export async function toggleVisibilityOnTab(tab: chrome.tabs.Tab): Promise<void> {
  if (tab.id === undefined) return;
  const status = await pingTab(tab.id);
  if (status) await sendToTab(tab.id, { type: 'TOGGLE_VISIBILITY' });
}

export async function getActiveTab(windowId: number): Promise<chrome.tabs.Tab | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, windowId });
  return tab;
}

/** Show a saved capture's marks over the live Figma tab (side panel action). */
export async function showCaptureOnTab(
  tab: chrome.tabs.Tab,
  captureId: string,
  force: boolean,
): Promise<ShowOnPageResult> {
  if (tab.id === undefined) throw new Error('No active tab');
  if (!tab.url) throw new Error(NO_ACCESS_MESSAGE);
  const live = parseFigmaUrl(tab.url);
  if (!live) throw new Error('The active tab is not a Figma design file.');
  const capture = await getCapture(captureId);
  if (!capture) throw new Error('Capture not found.');
  const captured = parseFigmaUrl(capture.pageUrl);
  if (!captured || projectKeyFor(captured) !== projectKeyFor(live)) {
    throw new Error('This capture belongs to a different Figma file. Open that file in this tab first.');
  }
  void prewarmReference(captureId).catch(() => undefined);
  await ensureOverlay(tab.id);
  // When marks follow the view, the overlay finds the captured area itself;
  // a different window size or zoom is not a problem.
  if (!force && !(await getSettings()).followView) {
    const viewport = await sendToTab(tab.id, { type: 'GET_VIEWPORT' });
    const comparison = compareViewport(capture, viewport);
    if (comparison.status === 'mismatch') return comparison;
  }
  await sendToTab(tab.id, { type: 'SHOW_CAPTURE', captureId });
  return { status: 'shown' };
}

/** Briefly flag a failure on the toolbar icon when no in-page UI can show it. */
export async function flagActionError(tabId: number | undefined, error: unknown): Promise<void> {
  console.warn('[overlay-notes]', errorMessage(error));
  if (tabId === undefined) return;
  try {
    await chrome.action.setBadgeBackgroundColor({ tabId, color: '#c92a2a' });
    await chrome.action.setBadgeText({ tabId, text: '!' });
    await chrome.action.setTitle({ tabId, title: `Design Overlay Notes: ${errorMessage(error)}` });
    setTimeout(() => {
      void chrome.action.setBadgeText({ tabId, text: '' }).catch(() => undefined);
      const defaultTitle = chrome.runtime.getManifest().action?.default_title ?? 'Design Overlay Notes';
      void chrome.action.setTitle({ tabId, title: defaultTitle }).catch(() => undefined);
    }, 6_000);
  } catch {
    // Tab closed.
  }
}
