import { defineDynamicResource, defineManifest } from '@crxjs/vite-plugin';
import pkg from './package.json' with { type: 'json' };
import { DEFAULT_SHORTCUTS } from './src/shared/constants.ts';

/**
 * Extension manifest (Manifest V3).
 *
 * Permissions are intentionally minimal — read the "Permissions" section of
 * IMPLEMENTATION_NOTES.md before adding anything here.
 *
 *  - activeTab:  temporary access to the Figma tab only after the user clicks
 *                the toolbar icon or presses one of our shortcuts.
 *  - scripting:  inject the overlay content script on demand.
 *  - storage:    small UI preferences in chrome.storage.local (never sync).
 *  - sidePanel:  the notes manager UI.
 *
 * The `e2e` build mode (used only by the automated smoke test) additionally
 * grants <all_urls> so Playwright can drive the extension without a real
 * toolbar click. That build is written to `dist-e2e/` and must never be
 * distributed.
 */
export default defineManifest((env) => {
  const isE2E = env.mode === 'e2e';
  const isDevServer = env.command === 'serve';

  return {
    manifest_version: 3,
    name: isE2E ? 'Design Overlay Notes (E2E TEST BUILD)' : 'Design Overlay Notes',
    short_name: 'Overlay Notes',
    version: pkg.version,
    description:
      'Private, local-only sketch notes over Figma designs. Nothing is written to Figma or sent anywhere.',
    minimum_chrome_version: '116',
    icons: {
      16: 'icons/icon-16.png',
      32: 'icons/icon-32.png',
      48: 'icons/icon-48.png',
      128: 'icons/icon-128.png',
    },
    action: {
      default_title: `Design Overlay Notes: annotate this Figma view (${DEFAULT_SHORTCUTS.activate})`,
      default_icon: {
        16: 'icons/icon-16.png',
        32: 'icons/icon-32.png',
      },
    },
    background: {
      service_worker: 'src/background/service-worker.ts',
      type: 'module',
    },
    side_panel: {
      default_path: 'src/sidepanel/index.html',
    },
    permissions: ['activeTab', 'scripting', 'storage', 'sidePanel'],
    // Opt-in (Settings → "Work on Figma tabs without a click"): lets "Open in
    // Figma" and side-panel actions reach Figma tabs without an icon click.
    optional_host_permissions: ['https://www.figma.com/*'],
    ...(isE2E ? { host_permissions: ['<all_urls>'] } : {}),
    commands: {
      _execute_action: {
        suggested_key: { default: DEFAULT_SHORTCUTS.activate },
        description: 'Start annotating / toggle drawing mode',
      },
      'toggle-visibility': {
        suggested_key: { default: DEFAULT_SHORTCUTS.toggleVisibility },
        description: 'Hide or show the notes overlay',
      },
      'new-capture': {
        suggested_key: { default: DEFAULT_SHORTCUTS.newCapture },
        description: 'Take a new capture of the current Figma view',
      },
    },
    // CRXJS lists the programmatically injected content script here. Restrict
    // it to Figma (instead of CRXJS's default http(s)://*/*) and use dynamic
    // URLs so other sites cannot probe for the extension.
    web_accessible_resources: [
      defineDynamicResource({
        matches: isE2E ? ['http://127.0.0.1/*'] : ['https://www.figma.com/*'],
        use_dynamic_url: true,
      }),
    ],
    // Strict CSP for extension pages. `connect-src 'self' blob: data:` means
    // extension pages cannot make network requests to any remote server, which
    // enforces the local-only privacy requirement at the browser level.
    // The Vite dev server needs websocket/HTTP access, so the CSP is relaxed
    // only while running `npm run dev`.
    ...(isDevServer
      ? {}
      : {
          content_security_policy: {
            extension_pages:
              "default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; " +
              "img-src 'self' blob: data:; style-src 'self'; font-src 'self'; connect-src 'self' blob: data:",
          },
        }),
  };
});
