/**
 * Validated message handling in the service worker.
 *
 * Every handler is safe to run on a freshly started worker: no module-level
 * state is required, all durable state lives in IndexedDB/chrome.storage.
 */
import { blobToDataUrl } from '../shared/binary';
import { isSupportedPageUrl } from '../shared/figma-url';
import {
  contentRequestSchema,
  errorEnvelope,
  okEnvelope,
  pageRequestSchema,
  type ContentRequest,
  type DataChange,
  type PageRequest,
} from '../shared/messages';
import { getAnnotations, getCapture, getCaptureImages, getProject, replaceAnnotations } from '../database/repository';
import { getActiveTab, newCaptureOnTab, NO_ACCESS_MESSAGE, showCaptureOnTab } from './activation';
import { alignView } from './align-service';
import { openInFigma } from './open-in-figma';
import { captureTab } from './capture-service';
import { lastView, setTabOverlay, tabsShowing } from './overlay-registry';
import { getSettings, updateSettings } from '../database/settings';
import { pingTab, sendToTabQuietly } from './tab-bridge';
import { cleanFigmaTitle, parseFigmaUrl, projectKeyFor } from '../shared/figma-url';

type Sender = chrome.runtime.MessageSender;
type Respond = (response: unknown) => void;

function isExtensionPage(sender: Sender): boolean {
  return Boolean(sender.url?.startsWith(chrome.runtime.getURL('')));
}

/** Notify extension pages (side panel, review tabs) about a change. */
export function broadcastToPages(change: DataChange): void {
  chrome.runtime.sendMessage({ type: 'DATA_CHANGED', change } satisfies PageRequest).catch(() => {
    // No extension page open.
  });
}

/** Forward a data change to overlays that show the affected capture. */
async function forwardToTabs(change: DataChange, excludeTabId?: number): Promise<void> {
  if (change.scope === 'all') {
    for (const tabId of await tabsShowing(null)) sendToTabQuietly(tabId, { type: 'CAPTURE_DELETED', captureId: null });
    return;
  }
  if (!change.captureId) return;
  const tabs = (await tabsShowing(change.captureId)).filter((id) => id !== excludeTabId);
  if (tabs.length === 0) return;
  if (change.scope === 'capture-deleted') {
    for (const tabId of tabs) sendToTabQuietly(tabId, { type: 'CAPTURE_DELETED', captureId: change.captureId });
  } else if (change.scope === 'annotations') {
    for (const tabId of tabs) {
      sendToTabQuietly(tabId, {
        type: 'ANNOTATIONS_CHANGED',
        captureId: change.captureId,
        ...(change.sourceId ? { sourceId: change.sourceId } : {}),
      });
    }
  } else if (change.scope === 'captures') {
    const capture = await getCapture(change.captureId);
    if (capture) for (const tabId of tabs) sendToTabQuietly(tabId, { type: 'CAPTURE_META_CHANGED', capture });
  }
}

// ---------------------------------------------------------------------------
// Content script requests
// ---------------------------------------------------------------------------

async function handleContentRequest(request: ContentRequest, sender: Sender): Promise<unknown> {
  const tab = sender.tab;
  if (!tab || tab.id === undefined) throw new Error('Missing sender tab');
  const tabId = tab.id;

  switch (request.type) {
    case 'OVERLAY_STATE': {
      const parsed = parseFigmaUrl(sender.url);
      await setTabOverlay(tabId, { captureId: request.captureId, mode: request.mode }, parsed ? projectKeyFor(parsed) : null);
      return null;
    }

    case 'CAPTURE_CREATE': {
      if (sender.frameId !== 0) throw new Error('Captures can only be started from the top frame');
      // Trust Chrome's view of the sender URL, not what the page reports.
      const pageUrl = sender.url ?? '';
      if (!isSupportedPageUrl(pageUrl)) throw new Error('Captures are only supported on Figma design files');
      if (!tab.active) throw new Error('Switch to this tab before taking a capture');
      const capture = await captureTab(tab.windowId, pageUrl, request.metadata);
      const parsedUrl = parseFigmaUrl(pageUrl);
      const fileKey = parsedUrl ? projectKeyFor(parsedUrl) : null;
      await setTabOverlay(tabId, { captureId: capture.id, mode: 'annotate' }, fileKey);
      broadcastToPages({ scope: 'captures', captureId: capture.id, projectId: capture.projectId });
      const project = await getProject(capture.projectId);
      // Saved somewhere else than the file's own project (the user's choice): say where.
      const savedIn = project && fileKey && project.fileKey !== fileKey ? project.name : null;
      return { capture, savedIn };
    }

    case 'CAPTURE_LOAD': {
      const capture = await getCapture(request.captureId);
      if (!capture) throw new Error('Capture not found');
      const [annotations, view] = await Promise.all([getAnnotations(capture.id), lastView(tabId, capture.id)]);
      return { capture, annotations, lastView: view };
    }

    case 'ANNOTATIONS_SAVE': {
      await replaceAnnotations(request.captureId, request.annotations);
      const change: DataChange = { scope: 'annotations', captureId: request.captureId, sourceId: request.editorId };
      broadcastToPages(change);
      await forwardToTabs(change, tabId);
      return { savedAt: Date.now() };
    }

    case 'SCREENSHOT_GET': {
      const images = await getCaptureImages(request.captureId);
      if (!images) throw new Error('Capture image not found');
      return { dataUrl: await blobToDataUrl(images.screenshot) };
    }

    case 'VIEW_ALIGN': {
      if (sender.frameId !== 0) throw new Error('View alignment is only available in the top frame');
      if (!isSupportedPageUrl(sender.url ?? '')) throw new Error('View alignment is only supported on Figma design files');
      try {
        return await alignView(tab, request);
      } catch (error) {
        // Most likely no screenshot permission for this tab (activeTab expired).
        return { status: 'unavailable', reason: error instanceof Error ? error.message : String(error) };
      }
    }

    case 'SETTINGS_GET': {
      const commands = await chrome.commands.getAll().catch(() => [] as chrome.commands.Command[]);
      const shortcut = (name: string) => commands.find((c) => c.name === name)?.shortcut ?? '';
      return {
        settings: await getSettings(),
        shortcuts: {
          activate: shortcut('_execute_action'),
          newCapture: shortcut('new-capture'),
          toggleVisibility: shortcut('toggle-visibility'),
        },
      };
    }

    case 'SETTINGS_SET':
      return { settings: await updateSettings(request.patch) };

    case 'OPEN_SIDE_PANEL':
      // Handled synchronously in the listener (user gesture); see below.
      return null;

    case 'OPEN_REVIEW':
      await chrome.tabs.create({
        url: `${chrome.runtime.getURL('src/review/index.html')}?capture=${encodeURIComponent(request.captureId)}`,
        index: tab.index + 1,
        openerTabId: tabId,
      });
      return null;
  }
}

// ---------------------------------------------------------------------------
// Extension page requests
// ---------------------------------------------------------------------------

async function handlePageRequest(request: PageRequest): Promise<unknown> {
  switch (request.type) {
    case 'PANEL_GET_ACTIVE_TAB': {
      const tab = await getActiveTab(request.windowId);
      const url = tab?.url ?? null;
      const parsed = parseFigmaUrl(url);
      const overlay = tab?.id !== undefined && parsed ? await pingTab(tab.id, 400) : null;
      return {
        tabId: tab?.id ?? null,
        url,
        supported: parsed !== null,
        projectKey: parsed ? projectKeyFor(parsed) : null,
        fileName: parsed ? (cleanFigmaTitle(tab?.title ?? null) ?? parsed.slugName ?? null) : null,
        overlay,
      };
    }

    case 'PANEL_NEW_CAPTURE': {
      const tab = await getActiveTab(request.windowId);
      if (!tab) throw new Error('No active tab');
      if (!tab.url) throw new Error(NO_ACCESS_MESSAGE);
      return { captureId: await newCaptureOnTab(tab) };
    }

    case 'PANEL_SHOW_ON_PAGE': {
      const tab = await getActiveTab(request.windowId);
      if (!tab) throw new Error('No active tab');
      return showCaptureOnTab(tab, request.captureId, request.force);
    }

    case 'DATA_CHANGED':
      await forwardToTabs(request.change);
      return null;

    case 'PANEL_OPEN_IN_FIGMA':
      return openInFigma(request.windowId, request.captureId);
  }
}

// ---------------------------------------------------------------------------
// Listener
// ---------------------------------------------------------------------------

export function onRuntimeMessage(raw: unknown, sender: Sender, respond: Respond): boolean {
  if (sender.id !== chrome.runtime.id) return false;

  if (isExtensionPage(sender)) {
    const parsed = pageRequestSchema.safeParse(raw);
    if (!parsed.success) return false; // not addressed to the service worker
    handlePageRequest(parsed.data)
      .then((data) => respond(okEnvelope(data)))
      .catch((error: unknown) => respond(errorEnvelope(error)));
    return true;
  }

  // Content script.
  const parsed = contentRequestSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.length ? `${issue.path.join('.')}: ` : '';
    respond(errorEnvelope(new Error(`Invalid message (${where}${issue?.message ?? 'unknown'})`)));
    return false;
  }
  const request = parsed.data;

  if (request.type === 'OPEN_SIDE_PANEL') {
    // sidePanel.open() must be called synchronously while the user gesture
    // from the content script click is still active.
    const windowId = sender.tab?.windowId;
    if (windowId === undefined) {
      respond(errorEnvelope(new Error('Missing window')));
      return false;
    }
    chrome.sidePanel
      .open({ windowId })
      .then(() => respond(okEnvelope(null)))
      .catch((error: unknown) => respond(errorEnvelope(error)));
    return true;
  }

  handleContentRequest(request, sender)
    .then((data) => respond(okEnvelope(data)))
    .catch((error: unknown) => respond(errorEnvelope(error)));
  return true;
}
