/** Optional host permission for Figma (opt-in from the settings view). */
export const FIGMA_ORIGINS = ['https://www.figma.com/*'];

export async function hasFigmaAccess(): Promise<boolean> {
  try {
    return await chrome.permissions.contains({ origins: FIGMA_ORIGINS });
  } catch {
    return false;
  }
}
