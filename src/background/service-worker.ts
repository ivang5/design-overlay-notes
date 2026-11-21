/**
 * Extension service worker (Manifest V3).
 *
 * Chrome stops this worker when idle and restarts it for later events, so:
 *  - every listener is registered synchronously at the top level;
 *  - nothing important lives in module-level variables.
 */
import { isSupportedPageUrl } from '../shared/figma-url';
import {
  activateOnTab,
  flagActionError,
  newCaptureOnTab,
  toggleVisibilityOnTab,
} from './activation';
import { onRuntimeMessage } from './message-router';
import { forgetPendingShow } from './open-in-figma';
import { removeTab, tabsShowing } from './overlay-registry';
import { sendToTabQuietly } from './tab-bridge';
import { restrictStorageAccess } from '../database/settings';
import type { Settings } from '../shared/schemas';

chrome.runtime.onInstalled.addListener(() => {
  void restrictStorageAccess();
  // We handle action clicks ourselves (activate on Figma, panel elsewhere).
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => undefined);
});

chrome.runtime.onStartup.addListener(() => {
  void restrictStorageAccess();
});

chrome.action.onClicked.addListener((tab) => {
  if (!isSupportedPageUrl(tab.url)) {
    // Not a Figma file: open the notes manager instead. Must be synchronous
    // with the click to count as a user gesture.
    if (tab.windowId !== undefined) {
      chrome.sidePanel.open({ windowId: tab.windowId }).catch((error: unknown) => flagActionError(tab.id, error));
    }
    return;
  }
  activateOnTab(tab).catch((error: unknown) => flagActionError(tab.id, error));
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (!tab || !isSupportedPageUrl(tab.url)) return;
  if (command === 'toggle-visibility') {
    toggleVisibilityOnTab(tab).catch((error: unknown) => flagActionError(tab.id, error));
  } else if (command === 'new-capture') {
    newCaptureOnTab(tab).catch((error: unknown) => flagActionError(tab.id, error));
  }
});

chrome.runtime.onMessage.addListener(onRuntimeMessage);

chrome.tabs.onRemoved.addListener((tabId) => {
  void removeTab(tabId);
  void forgetPendingShow(tabId);
});

// Settings changed in the notes manager: tell open overlays.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.settings) return;
  const before = changes.settings.oldValue as Partial<Settings> | undefined;
  const after = changes.settings.newValue as Partial<Settings> | undefined;
  if (after?.followView === undefined || before?.followView === after.followView) return;
  const followView = after.followView;
  void tabsShowing(null).then((tabs) => {
    for (const tabId of tabs) sendToTabQuietly(tabId, { type: 'SETTINGS_CHANGED', followView });
  });
});

// Test hook, compiled in only for the e2e build (dist-e2e/).
if (__E2E__) {
  (globalThis as unknown as Record<string, unknown>).__overlayNotesE2E = {
    activate: async (tabId: number) => activateOnTab(await chrome.tabs.get(tabId)),
    newCapture: async (tabId: number) => newCaptureOnTab(await chrome.tabs.get(tabId)),
  };
}
