/**
 * "Open in Figma": bring up the capture's Figma file and show its notes there.
 *
 * Without host access the extension cannot touch a freshly opened tab until
 * the user clicks its icon, so the request is remembered per tab
 * (chrome.storage.session) and fulfilled by that click. With the optional
 * figma.com permission it happens automatically once the page has loaded.
 * The overlay then searches the view for the captured area.
 */
import { getCapture } from '../database/repository';
import { hasFigmaAccess } from '../shared/figma-access';
import { parseFigmaUrl, projectKeyFor } from '../shared/figma-url';
import type { OpenInFigmaResult } from '../shared/messages';
import { prewarmReference } from './align-service';
import { removeTab, tabsWithProject } from './overlay-registry';
import { ensureOverlay, pingTab, sendToTab } from './tab-bridge';

const PENDING_KEY = 'pendingShow';

type PendingMap = Record<string, string>;

async function readPending(): Promise<PendingMap> {
  return ((await chrome.storage.session.get(PENDING_KEY))[PENDING_KEY] as PendingMap | undefined) ?? {};
}

async function setPendingShow(tabId: number, captureId: string): Promise<void> {
  const pending = await readPending();
  pending[tabId] = captureId;
  await chrome.storage.session.set({ [PENDING_KEY]: pending });
}

/** Capture to show when the user next activates the extension on this tab. */
export async function takePendingShow(tabId: number): Promise<string | null> {
  const pending = await readPending();
  const captureId = pending[tabId] ?? null;
  if (captureId) {
    delete pending[tabId];
    await chrome.storage.session.set({ [PENDING_KEY]: pending });
  }
  return captureId;
}

export async function forgetPendingShow(tabId: number): Promise<void> {
  const pending = await readPending();
  if (pending[tabId]) {
    delete pending[tabId];
    await chrome.storage.session.set({ [PENDING_KEY]: pending });
  }
}

function waitForTabComplete(tabId: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('Figma took too long to load.'));
    }, timeoutMs);
    const listener = (id: number, info: chrome.tabs.OnUpdatedInfo) => {
      if (id === tabId && info.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    void chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === 'complete') listener(tabId, { status: 'complete' });
    });
  });
}

export async function openInFigma(windowId: number, captureId: string): Promise<OpenInFigmaResult> {
  const capture = await getCapture(captureId);
  if (!capture) throw new Error('Capture not found.');
  const target = parseFigmaUrl(capture.pageUrl);
  if (!target) throw new Error('This capture has no Figma link.');
  const key = projectKeyFor(target);
  // Decode the capture's screenshot while the tab comes up.
  void prewarmReference(captureId).catch(() => undefined);

  // Reuse a tab that already shows this file: one where our overlay runs on it
  // (known without any host permission), else any tab whose URL we can see.
  let tab: chrome.tabs.Tab | undefined;
  for (const id of await tabsWithProject(key)) {
    const candidate = await chrome.tabs.get(id).catch(() => undefined);
    if (!candidate) continue;
    // The tab may have left the file since (nobody tells the registry): trust
    // its URL when Chrome shows it to us, else whether our overlay still answers.
    const parsed = candidate.url ? parseFigmaUrl(candidate.url) : null;
    const stillThere = candidate.url
      ? parsed !== null && projectKeyFor(parsed) === key
      : (await pingTab(id, 300)) !== null;
    if (!stillThere) {
      await removeTab(id);
      continue;
    }
    if (!tab || candidate.windowId === windowId) tab = candidate;
  }
  if (!tab) {
    tab = (await chrome.tabs.query({ windowId })).find((t) => {
      const parsed = parseFigmaUrl(t.url);
      return parsed !== null && projectKeyFor(parsed) === key;
    });
  }
  if (tab?.id !== undefined) {
    await chrome.tabs.update(tab.id, { active: true });
    if (tab.windowId !== windowId) await chrome.windows.update(tab.windowId, { focused: true });
  } else {
    tab = await chrome.tabs.create({ windowId, url: capture.pageUrl, active: true });
  }
  const tabId = tab.id;
  if (tabId === undefined) throw new Error('Could not open the Figma tab.');

  if (await pingTab(tabId, 400)) {
    await sendToTab(tabId, { type: 'SHOW_CAPTURE', captureId, goToView: true });
    return { status: 'shown' };
  }
  if (await hasFigmaAccess()) {
    await waitForTabComplete(tabId, 30_000);
    await ensureOverlay(tabId);
    await sendToTab(tabId, { type: 'SHOW_CAPTURE', captureId, goToView: true });
    return { status: 'shown' };
  }
  await setPendingShow(tabId, captureId);
  return { status: 'needs-click' };
}
