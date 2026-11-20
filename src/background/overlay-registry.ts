/**
 * Which tabs currently show an overlay, and for which capture.
 * Stored in chrome.storage.session (memory-only, survives service worker
 * restarts, cleared when the browser closes, trusted contexts only).
 */
import type { OverlayMode, OverlayStatus } from '../shared/messages';

const KEY = 'overlayTabs';

type Registry = Record<string, OverlayStatus>;

async function read(): Promise<Registry> {
  const result = await chrome.storage.session.get(KEY);
  return (result[KEY] as Registry | undefined) ?? {};
}

async function write(registry: Registry): Promise<void> {
  await chrome.storage.session.set({ [KEY]: registry });
}

export async function setTabOverlay(tabId: number, status: OverlayStatus): Promise<void> {
  const registry = await read();
  if (status.mode === 'closed' && !status.captureId) delete registry[tabId];
  else registry[tabId] = status;
  await write(registry);
  await updateBadge(tabId, status.mode);
}

export async function removeTab(tabId: number): Promise<void> {
  const registry = await read();
  if (registry[tabId]) {
    delete registry[tabId];
    await write(registry);
  }
}

/** Tabs showing the given capture (or all overlay tabs when captureId is null). */
export async function tabsShowing(captureId: string | null): Promise<number[]> {
  const registry = await read();
  return Object.entries(registry)
    .filter(([, status]) => captureId === null || status.captureId === captureId)
    .map(([tabId]) => Number(tabId));
}

export async function updateBadge(tabId: number, mode: OverlayMode): Promise<void> {
  try {
    await chrome.action.setBadgeBackgroundColor({ tabId, color: '#1c7ed6' });
    await chrome.action.setBadgeText({ tabId, text: mode === 'annotate' ? 'ON' : '' });
  } catch {
    // Tab may have closed.
  }
}
