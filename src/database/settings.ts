/**
 * Small UI preferences in chrome.storage.local (never chrome.storage.sync).
 * Access is restricted to trusted extension contexts; content scripts go
 * through the service worker.
 */
import { DEFAULT_COLOR, DEFAULT_FONT_SIZE } from '../shared/constants';
import { settingsSchema, type Settings, type SettingsPatch } from '../shared/schemas';

const KEY = 'settings';

export const DEFAULT_SETTINGS: Settings = {
  tool: 'pen',
  color: DEFAULT_COLOR,
  size: 'm',
  fontSize: DEFAULT_FONT_SIZE,
  followView: true,
  toolbarPosition: null,
};

export async function getSettings(): Promise<Settings> {
  const stored = (await chrome.storage.local.get(KEY))[KEY] as Partial<Settings> | undefined;
  const parsed = settingsSchema.safeParse({ ...DEFAULT_SETTINGS, ...stored });
  return parsed.success ? parsed.data : DEFAULT_SETTINGS;
}

export async function updateSettings(patch: SettingsPatch): Promise<Settings> {
  const next = settingsSchema.parse({ ...(await getSettings()), ...patch });
  await chrome.storage.local.set({ [KEY]: next });
  return next;
}

export async function restrictStorageAccess(): Promise<void> {
  try {
    await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  } catch (error) {
    console.warn('[overlay-notes] Could not restrict storage access level', error);
  }
}
