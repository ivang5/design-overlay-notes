/**
 * Keeps marks attached to the design while Figma's canvas is panned/zoomed.
 *
 * 1. Prediction (same frame as Figma): Figma applies scroll/zoom input
 *    synchronously, without animation, so we can mirror it exactly:
 *      - wheel: pans by the wheel delta, clamped to ±120 px per event;
 *      - Ctrl/⌘+wheel and pinch: zoom around the pointer with Figma's own
 *        response curve (measured, see `figmaWheelZoom`);
 *      - drags with the hand tool, Space held or the middle button: pan by
 *        the pointer delta.
 *    Predictions are pushed to the overlay as "live" transforms that only move
 *    a composited layer (no re-render), so marks keep up at full frame rate.
 * 2. Confirmation (after input settles): the service worker compares a fresh
 *    screenshot with the capture's screenshot and returns the exact transform.
 *    Small differences are eased in; unpredictable changes (keyboard zoom,
 *    page switches) hide the marks until the captured area is found again.
 */
import type { ViewAlignResult } from '../shared/messages';
import type { RegionGrid } from '../shared/region-grid';
import {
  IDENTITY_TRANSFORM,
  composeTransforms,
  invertTransform,
  panDelta,
  transformDistance,
  zoomDelta,
  type ViewTransform,
} from '../shared/view-transform';
import {
  canvasCursor,
  computeRegionGrid,
  findFigmaCanvas,
  isEditableTarget,
  isFigmaCanvas,
  isHandToolActive,
  readFigmaPage,
  readFigmaZoom,
} from './figma-dom';

export type ViewStatus =
  /** Tracking disabled or unsupported page: marks stay at their capture position. */
  | 'off'
  /** Marks follow the design. */
  | 'following'
  /** View changed unpredictably; marks hidden until re-found. */
  | 'searching'
  /** Capture's area is not visible in the current view. */
  | 'lost';

export interface ViewState {
  transform: ViewTransform;
  status: ViewStatus;
}

export interface AlignRequestInput {
  seed: ViewTransform | null;
  /** Are our marks drawn on screen at `seed` (so their pixels must be ignored)? */
  inkVisible: boolean;
  scaleHint: number | null;
  /** Relative uncertainty of `scaleHint` (e.g. 0.02 = ±2 %). */
  scaleTolerance: number | null;
  /** The seed's scale is exact (Figma's zoom curve / preset levels): refine position first. */
  lockScale: boolean;
  region: RegionGrid | null;
}

export interface ViewTrackerDelegate {
  /** Overlay root inside our shadow DOM (made hit-test transparent while probing). */
  overlayRoot: HTMLElement;
  /** Our overlay host element (events from it are ours, not Figma's). */
  host: HTMLElement;
  /** Should input be tracked right now (capture shown, overlay visible, tracking on)? */
  isTracking(): boolean;
  /** Following is enabled at all (setting). Figma's view is then tracked even with no capture shown. */
  followEnabled(): boolean;
  /** Zoom Figma's canvas by `factor` around its centre (synthetic wheel input); resolves once applied. */
  zoomCanvas(factor: number): Promise<void>;
  /** False while our drawing mode captures the keyboard (keys never reach Figma then). */
  keysReachFigma(): boolean;
  /** Figma zoom level at capture time, if recorded. */
  captureZoom(): number | null;
  /** Capture viewport size (CSS px), to judge whether its area should be visible. */
  captureSize(): { width: number; height: number } | null;
  /** Committed state changed (status, or the transform the overlay renders with). */
  onChange(state: ViewState): void;
  /** Frequent: a predicted transform to show right now (cheap, no re-render). */
  onLive(transform: ViewTransform): void;
  /** A screenshot check confirmed where the capture is. */
  onConfirmed(transform: ViewTransform): void;
  align(input: AlignRequestInput): Promise<ViewAlignResult>;
}

/** Wait this long after the last input before confirming the view. */
const SETTLE_MS = 220;
const SETTLE_AFTER_KEYS_MS = 380;
/** Plain clicks rarely move the view; verify them lazily. */
const VERIFY_AFTER_CLICK_MS = 900;
const MIN_CLICK_VERIFY_INTERVAL_MS = 4_000;
/** Re-check once after a search-based result (Figma may still be refining its rendering). */
const CONFIRM_AFTER_SEARCH_MS = 700;
/** Corrections smaller than this (screen px) are eased in instead of jumping. */
const EASE_MAX_PX = 60;
const EASE_MS = 140;
/** Figma pans at most this far per wheel event (measured). */
const WHEEL_PAN_CLAMP = 120;

/**
 * Figma's Ctrl/⌘+wheel zoom response, measured on Figma (Chrome, Nov 2026):
 * ln(factor) = −0.005 · d for |deltaY| ≤ 30, and the effective delta grows
 * with the cube root beyond that (30^(2/3)·|Δ|^(1/3)). Fits all measurements
 * (Δ 1…400) within the zoom label's rounding.
 */
export function figmaWheelZoom(deltaY: number): number {
  const magnitude = Math.abs(deltaY);
  const effective = Math.min(magnitude, 9.6549 * Math.cbrt(magnitude));
  return Math.exp(-Math.sign(deltaY) * 0.005 * effective);
}

function wheelPixels(e: WheelEvent): { dx: number; dy: number } {
  const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? innerHeight : 1;
  return { dx: e.deltaX * unit, dy: e.deltaY * unit };
}

const clampPan = (v: number) => Math.max(-WHEEL_PAN_CLAMP, Math.min(WHEEL_PAN_CLAMP, v));

/**
 * Keyboard shortcuts that move Figma's view:
 *  - 'zoom': zoom in/out/100 % around the canvas centre (measured), to a level
 *    shown by the zoom label → predictable once the label changes;
 *  - 'jump': zoom to fit / selection, page navigation → position unknown.
 */
function viewKeyKind(e: KeyboardEvent): 'zoom' | 'jump' | null {
  const k = e.key;
  if (e.shiftKey && e.code === 'Digit0') return 'zoom';
  if (['+', '-', '=', '_'].includes(k)) return 'zoom'; // with or without Ctrl/⌘
  if ((e.ctrlKey || e.metaKey) && k === '0') return 'zoom';
  if (e.shiftKey && /^Digit[1-9]$/.test(e.code)) return 'jump'; // zoom to fit / selection / …
  if (k === 'PageUp' || k === 'PageDown' || k === 'Home' || k === 'End') return 'jump'; // page navigation
  return null;
}

/** Zoom levels Figma's +/−/Shift+0 land on exactly (the label is then exact, not rounded). */
const PRESET_ZOOMS = [0.25, 0.5, 1, 2, 4, 8, 16, 32, 64, 128, 256];
const isPresetZoom = (z: number) => PRESET_ZOOMS.some((p) => Math.abs(p - z) < 1e-9);

type Pending = 'none' | 'exact' | 'predicted' | 'unknown' | 'verify';

/** Test builds expose a short decision trace on <html data-don-trace> for the e2e tests. */
function trace(message: string): void {
  if (!__E2E__) return;
  const root = document.documentElement;
  const lines = (root.dataset.donTrace ?? '').split('\n').filter(Boolean);
  lines.push(`${Math.round(performance.now())} ${message}`);
  root.dataset.donTrace = lines.slice(-60).join('\n');
}

const rank: Record<Pending, number> = { none: 0, verify: 1, exact: 2, predicted: 3, unknown: 4 };

/** Figma's minimum zoom level (2 %). */
const MIN_FIGMA_ZOOM = 0.02;

/**
 * A reference view of the current Figma page for this tab: `view` maps frame
 * coordinates → live CSS px and is kept up to date by the same exact input
 * predictions as the marks, also while no capture is shown. `null` after a
 * change we could not follow (zoom to fit, page reload of the overlay…).
 * Epochs separate frames that were started independently.
 */
interface ViewFrame {
  epoch: number;
  page: string | null;
  view: ViewTransform | null;
}

/** Where a capture lies in a frame: live = frame.view ∘ p. */
interface Placement {
  page: string | null;
  epoch: number;
  p: ViewTransform;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function lerpTransform(a: ViewTransform, b: ViewTransform, k: number): ViewTransform {
  return {
    s: Math.exp(Math.log(a.s) + (Math.log(b.s) - Math.log(a.s)) * k),
    tx: a.tx + (b.tx - a.tx) * k,
    ty: a.ty + (b.ty - a.ty) * k,
  };
}

export class ViewTracker {
  /** Committed state (what the overlay renders without a live offset). */
  private state: ViewState = { transform: IDENTITY_TRANSFORM, status: 'off' };
  /** Latest prediction (≥ committed). */
  private live: ViewTransform = IDENTITY_TRANSFORM;
  private pending: Pending = 'none';
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  private inFlight = false;
  private again = false;
  private spaceDown = false;
  private learnedHandCursor: string | null = null;
  private drag: { pointerId: number; x: number; y: number } | null = null;
  /** Where an unpredicted press started (scrollbars, layer drags…). */
  private press: { pointerId: number; x: number; y: number } | null = null;
  private lastClickVerify = 0;
  /** One extra search when a confirmation unexpectedly fails while the area should be visible. */
  private suspectRetry = false;
  /** Figma zoom readout and our scale at the last confirmed alignment. */
  private confirmed: { zoom: number; s: number } | null = null;
  /**
   * Figma zoom ÷ our scale, i.e. the capture's exact Figma zoom, learned from
   * confirmed alignments. `error` is its relative uncertainty (the label is
   * rounded to whole percent; preset levels are exact).
   */
  private zoomRatio: { value: number; error: number } | null = null;
  private watchingZoom = 0;
  /**
   * The current scale came only from exact sources (confirmed alignments,
   * Figma's wheel-zoom curve, preset zoom levels) since the last confirmation.
   */
  private scaleTrusted = false;
  private canvasRect: DOMRect | null = null;
  private readonly cleanups: (() => void)[] = [];
  private generation = 0;
  /** Increments on every input that may move the view (results computed across it are stale). */
  private inputSerial = 0;
  private easing: { from: ViewTransform; to: ViewTransform; start: number; frame: number } | null = null;
  /** Capture whose marks are shown (placements are recorded for it). */
  private captureId: string | null = null;
  private epochs = 0;
  private frame: ViewFrame;
  /** Frames of pages we left (Figma restores each page's view when you return). */
  private readonly parkedFrames = new Map<string, ViewFrame>();
  private readonly placements = new Map<string, Placement>();
  private locating = false;
  private locateAborted = false;

  constructor(private readonly delegate: ViewTrackerDelegate) {
    // The view when the overlay starts is the first frame's origin.
    this.frame = { epoch: ++this.epochs, page: readFigmaPage(), view: IDENTITY_TRANSFORM };
    const opts = { capture: true, passive: true } as const;
    const on = <K extends keyof WindowEventMap>(type: K, fn: (e: WindowEventMap[K]) => void) => {
      window.addEventListener(type, fn, opts);
      this.cleanups.push(() => window.removeEventListener(type, fn, opts));
    };
    on('wheel', (e) => this.onWheel(e));
    on('pointerdown', (e) => this.onPointerDown(e));
    on('pointermove', (e) => this.onPointerMove(e));
    on('pointerup', (e) => this.onPointerUp(e));
    on('pointercancel', (e) => this.onPointerUp(e));
    on('keydown', (e) => this.onKeyDown(e));
    on('keyup', (e) => {
      if (e.key === ' ') this.spaceDown = false;
    });
    on('blur', () => {
      this.spaceDown = false;
    });
    on('resize', () => this.onResize());
  }

  getState(): ViewState {
    return this.state;
  }

  /** Latest transform to display (prediction or eased correction). */
  getLive(): ViewTransform {
    return this.live;
  }

  /**
   * Show a capture's marks: a new capture (identity, `placed`), a capture at a
   * known position (following), or one still to be found (searching — call
   * `locate()` next).
   */
  reset(
    status: 'following' | 'searching' | 'off',
    transform: ViewTransform = IDENTITY_TRANSFORM,
    captureId: string | null = null,
    placed = false,
  ): void {
    this.generation++;
    this.captureId = captureId;
    this.locateAborted = true; // a running locate() belongs to the previous capture
    this.pending = 'none';
    this.clearSettle();
    this.stopEasing();
    this.canvasRect = findFigmaCanvas()?.getBoundingClientRect() ?? null;
    this.confirmed = null;
    this.zoomRatio = null;
    this.suspectRetry = false;
    this.scaleTrusted = status === 'following';
    const zoom = readFigmaZoom();
    if (status === 'following' && zoom) {
      this.confirmed = { zoom, s: transform.s };
      this.learnZoomRatio(zoom, transform.s, false);
    }
    this.commit({ transform, status });
    if (placed && status === 'following') this.recordPlacement(transform);
  }

  /** Confirm the shown position soon (e.g. after showing it at a predicted place). */
  verifySoon(): void {
    this.schedule('verify', SETTLE_MS);
  }

  /** Predicted position of a capture from the tracked view, if it was found earlier in this tab. */
  predictedFor(captureId: string): ViewTransform | null {
    const placement = this.placements.get(captureId);
    const frame = this.frame;
    if (!placement || !frame.view || placement.epoch !== frame.epoch || placement.page !== readFigmaPage()) return null;
    return composeTransforms(frame.view, placement.p);
  }

  /** The view changed in a way we cannot predict (navigation, resize…). */
  invalidate(): void {
    const page = readFigmaPage();
    if (page !== this.frame.page) {
      // Another Figma page: park this page's frame (Figma restores each page's
      // view when you come back) and pick up the new page's frame, if any.
      if (this.frame.page !== null && this.frame.view) this.parkedFrames.set(this.frame.page, this.frame);
      this.frame = (page !== null ? this.parkedFrames.get(page) : undefined) ?? { epoch: ++this.epochs, page, view: null };
    }
    if (this.state.status === 'off') return;
    this.schedule('unknown', SETTLE_AFTER_KEYS_MS);
  }

  /**
   * Find the shown capture's area and place the marks on it. Looks at the
   * current view first; with `explore`, then zooms Figma out step by step
   * around the canvas centre (the area becomes visible at a lower zoom) and
   * searches again. If it is not found, the original view is restored.
   * Returns whether it was found. Real user input cancels the exploration.
   */
  async locate(options: { explore: boolean; justLoaded?: boolean }): Promise<boolean> {
    if (this.locating) return false;
    // Claim control first: a check still in flight must not apply its result.
    this.locating = true;
    this.locateAborted = false;
    while (this.inFlight) await sleep(30);
    this.clearSettle();
    this.pending = 'none';
    const generation = this.generation;
    const aborted = () => this.locateAborted || generation !== this.generation;
    if (this.state.status !== 'searching') this.commit({ transform: this.live, status: 'searching' });
    let zoomApplied = 1;
    try {
      if (await this.alignHere()) return true;
      if (options.justLoaded && !aborted()) {
        // Figma may still be drawing the canvas right after loading.
        await sleep(1_200);
        if (!aborted() && (await this.alignHere())) return true;
      }
      const startZoom = readFigmaZoom();
      const captureZoom = this.delegate.captureZoom();
      if (!options.explore || aborted() || !startZoom || !captureZoom) return this.giveUp(aborted());
      // Zoom out so the captured area shows at ½, ¼, then ⅐ of its captured size.
      let current = startZoom;
      for (const divisor of [2, 4, 7]) {
        const target = Math.max(MIN_FIGMA_ZOOM, captureZoom / divisor);
        if (target >= current * 0.95) continue;
        if (aborted()) return this.giveUp(true);
        const factor = target / current;
        trace(`explore: zoom ×${factor.toFixed(3)}`);
        await this.delegate.zoomCanvas(factor);
        zoomApplied *= factor;
        current = target;
        await sleep(160); // let Figma draw the new zoom level
        if (aborted()) return this.giveUp(true);
        // We know exactly how far we zoomed: a much tighter scale hint than
        // the rounded zoom label at low zoom levels.
        const hint = {
          scaleHint: (startZoom * zoomApplied) / captureZoom,
          scaleTolerance: 0.005 / startZoom + 0.005 / captureZoom + 0.006,
        };
        if (await this.alignHere(hint)) return true;
      }
      if (zoomApplied !== 1 && !aborted()) {
        trace('explore: not found, restoring the view');
        await this.delegate.zoomCanvas(1 / zoomApplied);
      }
      return this.giveUp(aborted());
    } finally {
      this.locating = false;
    }
  }

  private giveUp(userTookOver: boolean): false {
    if (userTookOver) {
      // The user moved Figma meanwhile: keep looking as they navigate.
      if (this.state.status !== 'off') this.schedule('unknown', SETTLE_MS);
    } else {
      this.commit({ transform: this.live, status: 'lost' });
    }
    return false;
  }

  /** One alignment of the current view for locate(); applies the result when found. */
  private async alignHere(hint?: { scaleHint: number; scaleTolerance: number }): Promise<boolean> {
    const generation = this.generation;
    const request = { ...this.buildRequest('unknown', this.live, false), ...hint };
    const result = await this.delegate.align(request).catch(() => null);
    if (!result || generation !== this.generation || this.locateAborted) return false;
    if (result.status !== 'aligned') return false;
    this.acceptAligned(result.transform, request.liveZoom, 'unknown');
    if (result.method === 'search') this.schedule('verify', CONFIRM_AFTER_SEARCH_MS);
    return true;
  }

  /**
   * We moved Figma's view ourselves by a known amount (e.g. "go to captured
   * view"): predict it like user input, then confirm.
   */
  expect(transform: ViewTransform): void {
    this.predict(transform, 'exact');
  }

  dispose(): void {
    this.clearSettle();
    this.stopEasing();
    for (const cleanup of this.cleanups) cleanup();
  }

  // -- input -----------------------------------------------------------------

  private isOurs(e: Event): boolean {
    return e.composedPath().includes(this.delegate.host);
  }

  private active(): boolean {
    return this.state.status !== 'off' && this.delegate.isTracking();
  }

  /** Track Figma's view at all (also with no capture shown, to keep the frame current). */
  private watching(): boolean {
    return this.delegate.followEnabled();
  }

  /** Real input while locate() is navigating hands control back to the user. */
  private noteUserInput(e: Event): void {
    if (e.isTrusted && this.locating) this.locateAborted = true;
  }

  /**
   * Input that moves Figma's view by `delta` (composed on the left): keep the
   * frame in sync and, when a capture is shown, move its marks.
   */
  private viewChanged(delta: ViewTransform | null, kind: 'exact' | 'predicted' | 'unknown'): void {
    if (this.frame.view) this.frame.view = delta && kind !== 'unknown' ? composeTransforms(delta, this.frame.view) : null;
    if (!this.active()) return;
    if (!delta || kind === 'unknown') {
      // Unknown zoom/jump: hide marks until we know where the capture is.
      this.commit({ transform: this.live, status: 'searching' });
      this.schedule('unknown', SETTLE_AFTER_KEYS_MS);
      return;
    }
    this.predict(composeTransforms(delta, this.live), kind);
  }

  /** Real wheel events over Figma and wheel events we forward from the drawing surface. */
  private onWheel(e: WheelEvent): void {
    if (!this.watching() || !isFigmaCanvas(e.target) || this.isOurs(e)) return;
    this.noteUserInput(e);
    const { dx, dy } = wheelPixels(e);
    if (e.ctrlKey || e.metaKey) {
      this.viewChanged(zoomDelta(figmaWheelZoom(dy), e.clientX, e.clientY), 'exact');
    } else if (e.shiftKey && dx === 0) {
      this.viewChanged(panDelta(-clampPan(dy), 0), 'predicted');
    } else {
      this.viewChanged(panDelta(-clampPan(dx), -clampPan(dy)), 'exact');
    }
  }

  private onPointerDown(e: PointerEvent): void {
    if (!this.watching() || this.isOurs(e)) return;
    this.noteUserInput(e);
    const canvas = isFigmaCanvas(e.target) ? e.target : null;
    const pans =
      canvas !== null &&
      (e.button === 1 || (e.button === 0 && (this.spaceDown || isHandToolActive(canvas, this.learnedHandCursor))));
    if (pans) this.drag = { pointerId: e.pointerId, x: e.clientX, y: e.clientY };
    else this.press = { pointerId: e.pointerId, x: e.clientX, y: e.clientY };
  }

  private onPointerMove(e: PointerEvent): void {
    const drag = this.drag;
    if (!drag || e.pointerId !== drag.pointerId) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    drag.x = e.clientX;
    drag.y = e.clientY;
    if (dx || dy) this.viewChanged(panDelta(dx, dy), 'exact');
  }

  private onPointerUp(e: PointerEvent): void {
    if (this.drag && e.pointerId === this.drag.pointerId) {
      this.drag = null;
      return;
    }
    const press = this.press && e.pointerId === this.press.pointerId ? this.press : null;
    this.press = null;
    if (!this.active() || this.isOurs(e)) return;
    if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 5) {
      // A drag we could not predict (scrollbar, moving layers…): check soon.
      this.schedule('verify', SETTLE_MS);
    } else if (Date.now() - this.lastClickVerify > MIN_CLICK_VERIFY_INTERVAL_MS) {
      // Clicks in Figma (pages list, layers, menus) can move the view; check lazily.
      this.schedule('verify', VERIFY_AFTER_CLICK_MS);
    }
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (e.key === ' ' && !isEditableTarget(e.target)) {
      if (!this.spaceDown) this.learnHandCursor();
      this.spaceDown = true;
    }
    if (!this.watching() || this.isOurs(e) || isEditableTarget(e.target) || !this.delegate.keysReachFigma()) return;
    this.noteUserInput(e);
    const viewKey = viewKeyKind(e);
    if (viewKey === 'zoom') {
      this.watchKeyboardZoom();
    } else if (viewKey === 'jump') {
      this.viewChanged(null, 'unknown');
    } else if (this.active() && Date.now() - this.lastClickVerify > MIN_CLICK_VERIFY_INTERVAL_MS) {
      // Other shortcuts rarely move the view; the zoom readout check in run() catches those that do.
      this.schedule('verify', SETTLE_AFTER_KEYS_MS);
    }
  }

  /**
   * Keyboard zoom: Figma zooms around the canvas centre and updates its zoom
   * label within a frame or two. Follow as soon as the label changes.
   */
  private watchKeyboardZoom(): void {
    const before = readFigmaZoom();
    const token = ++this.watchingZoom;
    let frames = 0;
    const tick = () => {
      if (token !== this.watchingZoom || !this.watching()) return;
      const after = readFigmaZoom();
      if (before && after && Math.abs(after - before) > 1e-9) {
        const canvas = findFigmaCanvas()?.getBoundingClientRect();
        // Prefer the learned exact zoom for "before"; the label may be rounded.
        const calibrated = this.active() && this.zoomRatio;
        const exactBefore = calibrated ? this.zoomRatio!.value * this.live.s : before;
        const cx = canvas ? canvas.left + canvas.width / 2 : innerWidth / 2;
        const cy = canvas ? canvas.top + canvas.height / 2 : innerHeight / 2;
        const exact = calibrated && isPresetZoom(after) && (this.zoomRatio?.error ?? 1) < 1e-6;
        this.viewChanged(zoomDelta(after / exactBefore, cx, cy), exact ? 'exact' : 'predicted');
        return;
      }
      if (++frames < 20) requestAnimationFrame(tick);
      else if (this.active()) this.schedule('verify', 0); // nothing visible happened (already at that level?)
    };
    requestAnimationFrame(tick);
  }

  /** Keep the most precise estimate of the capture's Figma zoom (label ÷ scale). */
  private learnZoomRatio(zoom: number, s: number, exact: boolean): void {
    const error = exact ? 0 : 0.005 / zoom;
    if (!this.zoomRatio || error <= this.zoomRatio.error) this.zoomRatio = { value: zoom / s, error };
  }

  /** Space shows Figma's hand cursor: remember it to recognize the hand tool later. */
  private learnHandCursor(): void {
    requestAnimationFrame(() => {
      const canvas = findFigmaCanvas();
      if (canvas && this.spaceDown) this.learnedHandCursor = canvasCursor(canvas);
    });
  }

  private onResize(): void {
    if (!this.watching()) return;
    // Figma keeps the canvas content anchored to the canvas' top-left corner.
    const rect = findFigmaCanvas()?.getBoundingClientRect() ?? null;
    if (rect && this.canvasRect) {
      const dx = rect.left - this.canvasRect.left;
      const dy = rect.top - this.canvasRect.top;
      if (dx || dy) this.viewChanged(panDelta(dx, dy), 'predicted');
      else if (this.active()) this.schedule('verify', SETTLE_AFTER_KEYS_MS);
    } else {
      this.viewChanged(null, 'unknown');
    }
    this.canvasRect = rect;
  }

  // -- prediction & alignment ---------------------------------------------------

  private predict(transform: ViewTransform, kind: 'exact' | 'predicted'): void {
    if (kind === 'predicted') this.scaleTrusted = false;
    if (this.easing) {
      // Input during an eased correction: apply the same view change to where
      // the correction was heading (new = D ∘ live  ⇒  new' = D ∘ target).
      const target = this.easing.to;
      const ds = transform.s / this.live.s;
      const dtx = transform.tx - ds * this.live.tx;
      const dty = transform.ty - ds * this.live.ty;
      this.stopEasing();
      transform = { s: ds * target.s, tx: ds * target.tx + dtx, ty: ds * target.ty + dty };
    }
    this.setLive(transform);
    // While lost, motion may bring the area back: search again (marks stay hidden).
    if (this.state.status === 'lost') this.commit({ transform, status: 'searching' });
    this.schedule(kind, SETTLE_MS);
  }

  private schedule(kind: Pending, delay: number): void {
    if (kind !== 'verify') this.inputSerial++;
    if (this.locating) return; // locate() runs its own alignments
    if (rank[kind] > rank[this.pending]) this.pending = kind;
    this.clearSettle();
    this.settleTimer = setTimeout(() => void this.run(), delay);
  }

  private clearSettle(): void {
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = null;
  }

  /** Expected share of the capture's area inside the Figma canvas under `t`. */
  private expectedVisibleShare(t: ViewTransform): number {
    const size = this.delegate.captureSize();
    const canvas = this.canvasRect ?? findFigmaCanvas()?.getBoundingClientRect() ?? null;
    if (!size || !canvas) return 0;
    const x0 = Math.max(canvas.left, t.tx);
    const y0 = Math.max(canvas.top, t.ty);
    const x1 = Math.min(canvas.right, t.tx + size.width * t.s);
    const y1 = Math.min(canvas.bottom, t.ty + size.height * t.s);
    const visible = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
    const canvasArea = canvas.width * canvas.height;
    return canvasArea > 0 ? visible / Math.min(canvasArea, size.width * size.height * t.s * t.s) : 0;
  }

  private async run(): Promise<void> {
    this.settleTimer = null;
    if (this.pending === 'none' || !this.active()) return;
    if (this.inFlight) {
      this.again = true;
      return;
    }
    let kind = this.pending;
    this.pending = 'none';
    trace(`run ${kind}`);
    if (kind === 'verify') this.lastClickVerify = Date.now();
    // Input has settled: let the overlay render the prediction natively (crisp after zooming).
    if (!this.easing && this.state.transform !== this.live) this.commit({ ...this.state, transform: this.live });
    this.inFlight = true;
    const generation = this.generation;
    const serial = this.inputSerial;
    const before = this.state;
    try {
      const request = this.buildRequest(kind, before.transform, before.status === 'following');
      const liveZoom = request.liveZoom;
      if (liveZoom && this.confirmed) {
        // Figma rounds the readout to whole percent: allow that much disagreement.
        const expected = this.confirmed.zoom * (before.transform.s / this.confirmed.s);
        const tolerance = 0.006 / liveZoom + 0.006 / this.confirmed.zoom + 0.01;
        if (Math.abs(Math.log(liveZoom / expected)) > tolerance) {
          // Zoom changed in a way we did not predict (menu, shortcut, zoom-to-fit…).
          kind = 'unknown';
          request.lockScale = false;
          if (!request.scaleHint) {
            request.scaleHint = (before.transform.s * liveZoom) / expected;
            request.scaleTolerance = 0.03;
          }
          if (before.status === 'following') this.commit({ ...this.state, status: 'searching' });
        }
      }
      request.inkVisible = before.status === 'following' && this.state.status === 'following';
      const result = await this.delegate.align(request);
      // Capture changed meanwhile, or locate() took over (it runs its own checks).
      if (generation !== this.generation || this.locating) return;
      // The screenshot may have been taken before or after input that arrived
      // during the request: the result cannot be trusted. The follow-up run
      // (already pending) checks again with the newer prediction.
      if (serial !== this.inputSerial) {
        trace('result discarded (view moved during alignment)');
        return;
      }
      if (result.status === 'aligned') {
        this.acceptAligned(result.transform, liveZoom, kind);
        if (result.method === 'search' && kind !== 'verify') {
          // Double-check a searched answer once the view has fully settled.
          this.schedule('verify', CONFIRM_AFTER_SEARCH_MS);
        }
      } else if (result.status === 'not-found') {
        const share = this.expectedVisibleShare(this.live);
        if (kind === 'exact' || (kind === 'verify' && share < 0.3)) {
          // Exact predictions (consistent with Figma's zoom label, checked above)
          // stay trusted: the area scrolled out of view, or is magnified too much
          // to confirm from the capture's pixels.
          if (this.state.status !== 'following') this.commit({ ...this.state, status: 'lost' });
        } else if (!this.suspectRetry && kind !== 'unknown') {
          // The area should be visible but was not confirmed: search before trusting or hiding.
          this.suspectRetry = true;
          this.commit({ ...this.state, status: 'searching' });
          this.schedule('unknown', 0);
        } else {
          this.commit({ ...this.state, status: 'lost' });
        }
      }
      // 'unavailable' (tab hidden, no permission): keep the prediction.
    } catch {
      // Messaging failed (extension reloaded); keep the prediction.
    } finally {
      this.inFlight = false;
      if (this.again || (this.pending !== 'none' && !this.settleTimer)) {
        this.again = false;
        if (this.pending === 'none') this.pending = 'verify';
        this.clearSettle();
        this.settleTimer = setTimeout(() => void this.run(), SETTLE_MS);
      }
    }
  }

  /** Alignment request for the current view (region probe, zoom hint, scale lock). */
  private buildRequest(
    kind: Pending,
    seed: ViewTransform,
    inkVisible: boolean,
  ): AlignRequestInput & { liveZoom: number | null } {
    const canvas = findFigmaCanvas();
    const region = canvas ? computeRegionGrid(canvas, this.delegate.overlayRoot) : null;
    const liveZoom = readFigmaZoom();
    const captureZoom = this.delegate.captureZoom();
    let scaleHint: number | null = null;
    let scaleTolerance: number | null = null;
    if (liveZoom && this.zoomRatio) {
      scaleHint = liveZoom / this.zoomRatio.value;
      scaleTolerance = (isPresetZoom(liveZoom) ? 0 : 0.005 / liveZoom) + this.zoomRatio.error + 0.004;
    } else if (liveZoom && captureZoom) {
      scaleHint = liveZoom / captureZoom;
      scaleTolerance = 0.005 / liveZoom + 0.005 / captureZoom + 0.004;
    }
    return {
      seed,
      inkVisible,
      scaleHint,
      scaleTolerance,
      lockScale: kind === 'exact' && this.scaleTrusted,
      region,
      liveZoom,
    };
  }

  /** A confirmed position for the shown capture. */
  private acceptAligned(transform: ViewTransform, liveZoom: number | null, kind: Pending): void {
    this.suspectRetry = false;
    this.scaleTrusted = true;
    if (liveZoom) {
      this.confirmed = { zoom: liveZoom, s: transform.s };
      // Preset levels reached by +/−/Shift+0 are exact; otherwise the label is rounded.
      this.learnZoomRatio(liveZoom, transform.s, isPresetZoom(liveZoom) && kind !== 'unknown');
    }
    this.settleOn(transform);
    this.recordPlacement(transform);
    this.delegate.onConfirmed(transform);
  }

  /**
   * Tie the shown capture to the tracked view frame (or re-anchor the frame on
   * it), so it can be found instantly later from anywhere on this page.
   */
  private recordPlacement(transform: ViewTransform): void {
    const id = this.captureId;
    if (!id) return;
    const page = readFigmaPage();
    const known = this.placements.get(id);
    if (known && known.page === page) {
      const anchored = composeTransforms(transform, invertTransform(known.p));
      if (this.frame.view && this.frame.page === page && this.frame.epoch !== known.epoch) {
        // Two frames are known at this moment: move the current frame's
        // placements over to the re-anchored one.
        const relation = composeTransforms(invertTransform(anchored), this.frame.view);
        for (const [otherId, other] of this.placements) {
          if (other.epoch === this.frame.epoch && other.page === page) {
            this.placements.set(otherId, { page, epoch: known.epoch, p: composeTransforms(relation, other.p) });
          }
        }
      }
      this.frame = { epoch: known.epoch, page, view: anchored };
    } else if (this.frame.view && this.frame.page === page) {
      this.placements.set(id, { page, epoch: this.frame.epoch, p: composeTransforms(invertTransform(this.frame.view), transform) });
    } else {
      this.frame = { epoch: ++this.epochs, page, view: transform };
      this.placements.set(id, { page, epoch: this.frame.epoch, p: IDENTITY_TRANSFORM });
    }
  }

  /** Apply a confirmed transform: ease small corrections, jump otherwise. */
  private settleOn(target: ViewTransform): void {
    const distance = transformDistance(target, this.live, innerWidth, innerHeight);
    const wasHidden = this.state.status !== 'following';
    if (distance <= 0.5) {
      this.commit({ transform: this.live, status: 'following' });
      return;
    }
    if (wasHidden || distance > EASE_MAX_PX || matchMedia('(prefers-reduced-motion: reduce)').matches) {
      this.stopEasing();
      this.setLive(target);
      this.commit({ transform: target, status: 'following' });
      return;
    }
    this.stopEasing();
    const from = this.live;
    const start = performance.now();
    const step = () => {
      const k = Math.min(1, (performance.now() - start) / EASE_MS);
      const eased = 1 - (1 - k) ** 3;
      if (k >= 1) {
        this.easing = null;
        this.setLive(target);
        this.commit({ transform: target, status: 'following' });
        return;
      }
      this.setLive(lerpTransform(from, target, eased));
      if (this.easing) this.easing.frame = requestAnimationFrame(step);
    };
    this.easing = { from, to: target, start, frame: requestAnimationFrame(step) };
    if (this.state.status !== 'following') this.commit({ ...this.state, status: 'following' });
  }

  private stopEasing(): void {
    if (!this.easing) return;
    cancelAnimationFrame(this.easing.frame);
    this.easing = null;
  }

  private setLive(transform: ViewTransform): void {
    this.live = transform;
    this.delegate.onLive(transform);
  }

  /** Change the committed state (re-renders the overlay). */
  private commit(state: ViewState): void {
    if (state.transform === this.state.transform && state.status === this.state.status) return;
    const t = state.transform;
    trace(`set ${state.status} s=${t.s.toFixed(4)} t=${t.tx.toFixed(1)},${t.ty.toFixed(1)}`);
    this.state = state;
    if (!this.easing) this.live = state.transform;
    this.delegate.onChange(state);
  }
}
