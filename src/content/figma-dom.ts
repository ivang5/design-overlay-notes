/**
 * Read-only probes of Figma's page structure used by view tracking. Nothing
 * here touches Figma's internals or modifies the page; if Figma's DOM changes
 * these return null and the overlay falls back to fixed (non-following) marks.
 */
import { encodeRegionGrid, type RegionGrid } from '../shared/region-grid';

const REGION_CELL = 16;

let cachedCanvas: HTMLCanvasElement | null = null;

/**
 * Cheap check used on every wheel/pointer event: is this Figma's canvas?
 * Falls back to a full lookup when Figma replaced the element.
 */
export function isFigmaCanvas(target: EventTarget | null): target is HTMLCanvasElement {
  if (!(target instanceof HTMLCanvasElement)) return false;
  if (target === cachedCanvas && target.isConnected) return true;
  cachedCanvas = findFigmaCanvas();
  return target === cachedCanvas;
}

/**
 * Is Figma's hand tool active? Figma marks the active tool in its toolbar
 * (`aria-pressed="true"` on "Hand tool"). While Space is held the canvas
 * shows the same "hand" cursor, which serves as a fallback signature.
 */
export function isHandToolActive(canvas: HTMLCanvasElement, learnedHandCursor: string | null): boolean {
  if (document.querySelector('button[aria-pressed="true"][aria-label="Hand tool" i], button[aria-pressed="true"][data-testid="Hand tool-tool"]')) {
    return true;
  }
  return learnedHandCursor !== null && getComputedStyle(canvas).cursor === learnedHandCursor;
}

export function canvasCursor(canvas: HTMLCanvasElement): string {
  return getComputedStyle(canvas).cursor;
}

/** Name of the Figma page shown now (Pages panel: the row marked aria-current="page"). */
export function readFigmaPage(): string | null {
  const button = document.querySelector<HTMLElement>('[data-testid="PagesRowWrapper"] button[aria-current="page"]');
  const name = button?.textContent?.trim();
  return name ? name : null;
}

/**
 * Switch Figma to another page by clicking its row in the Pages panel (a
 * navigation, like the user clicking it). Returns false when not found.
 */
export function switchFigmaPage(name: string): boolean {
  const button = [...document.querySelectorAll<HTMLButtonElement>('[data-testid="PagesRowWrapper"] button')].find(
    (b) => b.textContent?.trim() === name,
  );
  if (!button) return false;
  if (button.getAttribute('aria-current') !== 'page') button.click();
  return true;
}

/** Figma has rendered its canvas and toolbar (not still loading the file). */
export function isFigmaReady(): boolean {
  return findFigmaCanvas() !== null && readFigmaZoom() !== null;
}

/** Figma renders the design into one large <canvas>. */
export function findFigmaCanvas(): HTMLCanvasElement | null {
  let best: HTMLCanvasElement | null = null;
  let bestArea = 0;
  for (const canvas of document.querySelectorAll('canvas')) {
    const r = canvas.getBoundingClientRect();
    const area = Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0)) *
      Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
    if (area > bestArea) {
      best = canvas;
      bestArea = area;
    }
  }
  cachedCanvas = best && bestArea >= innerWidth * innerHeight * 0.2 ? best : null;
  return cachedCanvas;
}

/**
 * Figma's zoom level (1 = 100%), parsed from the zoom menu button label
 * (e.g. "10%, zoom and view options"). Rounded to whole percent by Figma.
 */
export function readFigmaZoom(): number | null {
  const candidates = document.querySelectorAll<HTMLElement>('button[aria-label*="zoom" i], [role="button"][aria-label*="zoom" i]');
  for (const el of candidates) {
    const label = el.getAttribute('aria-label') ?? '';
    const match = /^\s*(\d+(?:[.,]\d+)?)\s*%/.exec(label) ?? /^\s*(\d+(?:[.,]\d+)?)\s*%\s*$/.exec(el.textContent ?? '');
    if (match) {
      const value = Number.parseFloat(match[1]!.replace(',', '.'));
      if (value > 0 && value < 100_000) return value / 100;
    }
  }
  return null;
}

/** Hit-test spacing (CSS px). Figma's DOM is heavy; each probe costs ~0.05 ms. */
const PROBE = 48;

/**
 * Which viewport cells show the Figma canvas (not panels, toolbars or
 * dialogs). Cells must lie fully inside the canvas element; UI floating over
 * the canvas is found by hit-testing a coarse lattice and excluded together
 * with one lattice cell around it. Our own overlay is made transparent to hit
 * testing while probing; the caller excludes our toolbar separately.
 */
export function computeRegionGrid(canvas: HTMLCanvasElement, overlayRoot: HTMLElement): RegionGrid {
  const cols = Math.ceil(innerWidth / REGION_CELL);
  const rows = Math.ceil(innerHeight / REGION_CELL);
  const rect = canvas.getBoundingClientRect();
  const left = Math.max(0, rect.left);
  const top = Math.max(0, rect.top);
  const right = Math.min(innerWidth, rect.right);
  const bottom = Math.min(innerHeight, rect.bottom);
  const pcols = Math.max(1, Math.ceil((right - left) / PROBE));
  const prows = Math.max(1, Math.ceil((bottom - top) / PROBE));
  const visible = new Uint8Array(pcols * prows);
  overlayRoot.classList.add('don-probing');
  try {
    for (let pr = 0; pr < prows; pr++) {
      for (let pc = 0; pc < pcols; pc++) {
        const x = Math.min(right - 1, left + (pc + 0.5) * PROBE);
        const y = Math.min(bottom - 1, top + (pr + 0.5) * PROBE);
        visible[pr * pcols + pc] = document.elementFromPoint(x, y) === canvas ? 1 : 0;
      }
    }
  } finally {
    overlayRoot.classList.remove('don-probing');
  }
  const clear = (pc: number, pr: number) => {
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        const c = pc + dc;
        const r = pr + dr;
        if (c >= 0 && r >= 0 && c < pcols && r < prows && !visible[r * pcols + c]) return false;
      }
    }
    return true;
  };
  return encodeRegionGrid(REGION_CELL, cols, rows, (col, row) => {
    const x0 = col * REGION_CELL;
    const y0 = row * REGION_CELL;
    if (x0 < left || y0 < top || x0 + REGION_CELL > right || y0 + REGION_CELL > bottom) return false;
    const pc = Math.min(pcols - 1, Math.floor((x0 + REGION_CELL / 2 - left) / PROBE));
    const pr = Math.min(prows - 1, Math.floor((y0 + REGION_CELL / 2 - top) / PROBE));
    return clear(pc, pr);
  });
}

/**
 * Is the user typing into a visible text field? Figma keeps keyboard focus in
 * an off-screen 1-px <input class="focus-target"> while the canvas is active,
 * so editable-but-invisible elements count as "not typing".
 */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const editable =
    target.isContentEditable ||
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement;
  if (!editable) return false;
  const r = target.getBoundingClientRect();
  return r.width > 4 && r.height > 4 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
}
