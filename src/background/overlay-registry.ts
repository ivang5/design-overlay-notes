/**
 * Which tabs currently show an overlay, and for which capture.
 * Stored in chrome.storage.session (memory-only, survives service worker
 * restarts, cleared when the browser closes, trusted contexts only).
 */
import type { OverlayMode, OverlayStatus } from '../shared/messages';

const KEY = 'overlayTabs';
const VIEWS_KEY = 'lastViews';

/** Overlay status plus which Figma file the tab shows (from Chrome's sender.url). */
type Entry = OverlayStatus & { projectKey?: string | null };
type Registry = Record<string, Entry>;

async function read(): Promise<Registry> {
  const result = await chrome.storage.session.get(KEY);
  return (result[KEY] as Registry | undefined) ?? {};
}

async function write(registry: Registry): Promise<void> {
  await chrome.storage.session.set({ [KEY]: registry });
}

export async function setTabOverlay(tabId: number, status: OverlayStatus, projectKey?: string | null): Promise<void> {
  const registry = await read();
  if (status.mode === 'closed' && !status.captureId && !projectKey) delete registry[tabId];
  else registry[tabId] = { ...status, projectKey: projectKey ?? registry[tabId]?.projectKey ?? null };
  await write(registry);
  await updateBadge(tabId, status.mode);
}

/** Tabs whose overlay is running on the given Figma file (no host permission needed). */
export async function tabsWithProject(projectKey: string): Promise<number[]> {
  const registry = await read();
  return Object.entries(registry)
    .filter(([, entry]) => entry.projectKey === projectKey)
    .map(([tabId]) => Number(tabId));
}

type ViewMap = Record<string, { s: number; tx: number; ty: number; at: number }>;

/** Where a capture was last found in a tab, so showing it again starts there. */
export async function rememberView(tabId: number, captureId: string, view: { s: number; tx: number; ty: number }): Promise<void> {
  const views = ((await chrome.storage.session.get(VIEWS_KEY))[VIEWS_KEY] as ViewMap | undefined) ?? {};
  views[`${tabId}:${captureId}`] = { ...view, at: Date.now() };
  // Keep the map small: the 50 most recent.
  const entries = Object.entries(views).sort((a, b) => b[1].at - a[1].at).slice(0, 50);
  await chrome.storage.session.set({ [VIEWS_KEY]: Object.fromEntries(entries) });
}

export async function lastView(tabId: number, captureId: string): Promise<{ s: number; tx: number; ty: number } | null> {
  const views = ((await chrome.storage.session.get(VIEWS_KEY))[VIEWS_KEY] as ViewMap | undefined) ?? {};
  const view = views[`${tabId}:${captureId}`];
  return view ? { s: view.s, tx: view.tx, ty: view.ty } : null;
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
