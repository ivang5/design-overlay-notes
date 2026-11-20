/**
 * Content script entry. Injected on demand by the service worker with
 * chrome.scripting.executeScript() after the user clicks the extension icon
 * (or presses a shortcut) on a Figma tab. Runs in Chrome's isolated world.
 *
 * It never reads Figma's DOM, globals or canvas — it only mounts its own host
 * element and reads standard viewport metrics.
 */
import { OverlayController } from './controller';

type OverlayGlobal = typeof globalThis & { __designOverlayNotes?: OverlayController };

(() => {
  const g = globalThis as OverlayGlobal;
  // Repeated injection must not create a second overlay.
  if (g.__designOverlayNotes?.isAlive()) return;
  g.__designOverlayNotes?.teardown();

  const controller = new OverlayController();
  g.__designOverlayNotes = controller;
  chrome.runtime.onMessage.addListener(controller.handleMessage);
})();
