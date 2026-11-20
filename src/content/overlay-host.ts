/**
 * Mounts a single fixed, full-viewport host element at the document root and
 * attaches a closed Shadow DOM so our styles and markup are isolated from
 * Figma (and Figma's scripts cannot reach into it via element.shadowRoot).
 */
import { OVERLAY_HOST_TAG } from '../shared/constants';

export interface OverlayHost {
  host: HTMLElement;
  shadow: ShadowRoot;
  container: HTMLDivElement;
  /** Temporarily remove the overlay from rendering (used right before a capture). */
  setRendered(rendered: boolean): void;
  destroy(): void;
}

const HOST_STYLE: Record<string, string> = {
  all: 'initial',
  display: 'block',
  position: 'fixed',
  inset: '0',
  margin: '0',
  padding: '0',
  border: '0',
  background: 'transparent',
  'z-index': '2147483647',
  'pointer-events': 'none',
  overflow: 'visible',
  contain: 'layout style',
};

export function createOverlayHost(cssText: string): OverlayHost {
  // Remove hosts left behind by a previous extension instance (e.g. after the
  // extension was reloaded/updated while the tab stayed open).
  for (const stale of document.querySelectorAll(OVERLAY_HOST_TAG)) stale.remove();

  const host = document.createElement(OVERLAY_HOST_TAG);
  for (const [property, value] of Object.entries(HOST_STYLE)) {
    host.style.setProperty(property, value, 'important');
  }
  const shadow = host.attachShadow({ mode: 'closed' });

  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(cssText);
    shadow.adoptedStyleSheets = [sheet];
  } catch {
    const style = document.createElement('style');
    style.textContent = cssText;
    shadow.appendChild(style);
  }

  const container = document.createElement('div');
  container.className = 'don-ui don-root';
  container.tabIndex = -1;
  shadow.appendChild(container);

  document.documentElement.appendChild(host);

  // Keep the host attached if the page replaces/cleans root children.
  const observer = new MutationObserver(() => {
    if (!host.isConnected) document.documentElement.appendChild(host);
  });
  observer.observe(document.documentElement, { childList: true });

  return {
    host,
    shadow,
    container,
    setRendered(rendered) {
      host.style.setProperty('display', rendered ? 'block' : 'none', 'important');
    },
    destroy() {
      observer.disconnect();
      host.remove();
    },
  };
}

/** Wait until the browser has produced frames without the overlay. */
export function waitForPaint(frames = 2, timeoutMs = 250): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        resolve();
      }
    };
    // rAF does not run in background tabs, so always have a timeout.
    const timer = setTimeout(finish, timeoutMs);
    let remaining = frames;
    const tick = () => {
      remaining -= 1;
      if (remaining <= 0) {
        clearTimeout(timer);
        // One macrotask more so the compositor can present the frame.
        setTimeout(finish, 16);
      } else {
        requestAnimationFrame(tick);
      }
    };
    requestAnimationFrame(tick);
  });
}
