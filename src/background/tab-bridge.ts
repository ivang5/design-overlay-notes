/**
 * Talking to the overlay content script in a tab, and injecting it on demand.
 */
import overlayScript from '../content/entry.tsx?iife';
import {
  unwrap,
  type Envelope,
  type OverlayStatus,
  type TabCommand,
  type TabResponses,
} from '../shared/messages';

export async function sendToTab<T extends TabCommand['type']>(
  tabId: number,
  command: Extract<TabCommand, { type: T }>,
): Promise<TabResponses[T]> {
  const response = (await chrome.tabs.sendMessage(tabId, command, { frameId: 0 })) as
    | Envelope<TabResponses[T]>
    | undefined;
  return unwrap(response);
}

/** Returns the overlay status, or null when no (live) content script is present. */
export async function pingTab(tabId: number, timeoutMs = 800): Promise<OverlayStatus | null> {
  try {
    return await Promise.race([
      sendToTab(tabId, { type: 'PING' }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]);
  } catch {
    return null;
  }
}

/**
 * Make sure the overlay content script is running in the tab's top frame.
 * Requires host access to the tab (granted temporarily by activeTab after the
 * user clicked the icon or pressed a shortcut on that tab).
 */
export async function ensureOverlay(tabId: number): Promise<OverlayStatus> {
  const existing = await pingTab(tabId);
  if (existing) return existing;
  await chrome.scripting.executeScript({
    target: { tabId, frameIds: [0] },
    files: [overlayScript],
    world: 'ISOLATED',
  });
  const status = await pingTab(tabId, 2_000);
  if (!status) throw new Error('The overlay did not start on this page.');
  return status;
}

export function sendToTabQuietly(tabId: number, command: TabCommand): void {
  chrome.tabs.sendMessage(tabId, command, { frameId: 0 }).catch(() => {
    // The tab navigated away or closed; nothing to update.
  });
}
