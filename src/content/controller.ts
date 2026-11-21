/**
 * Overlay controller: owns the overlay's state machine, the editor store,
 * autosave, the capture flow and the isolation between our UI and Figma.
 *
 * Modes:
 *   closed   – nothing rendered (content script still loaded)
 *   browse   – marks visible, pointer input passes through to Figma
 *   annotate – drawing surface captures pointer + keyboard input
 *   hidden   – marks hidden, only a small pill remains
 */
import { createRoot, type Root } from 'react-dom/client';
import { createElement } from 'react';
import editorCss from '../editor/editor.css?inline';
import overlayCss from './overlay.css?inline';
import { Autosaver } from '../editor/autosave';
import { annotationBounds } from '../editor/geometry';
import { getTextMeasurer } from '../editor/text-layout';
import { handleEditorKeydown } from '../editor/keyboard';
import { EditorStore } from '../editor/store';
import type { SaveStatus } from '../editor/Toolbar';
import { DEFAULT_SHORTCUTS } from '../shared/constants';
import { compareViewport, type LiveViewport } from '../shared/coordinates';
import { dataUrlToBlob } from '../shared/binary';
import { parseFigmaUrl, projectKeyFor } from '../shared/figma-url';
import { decodeRegionGrid } from '../shared/region-grid';
import { createId } from '../shared/ids';
import {
  errorEnvelope,
  errorMessage,
  okEnvelope,
  sendToBackground,
  tabCommandSchema,
  type ContentRequest,
  type ContentResponses,
  type OverlayMode,
  type OverlayStatus,
  type Shortcuts,
  type TabCommand,
  type TabResponses,
} from '../shared/messages';
import type { Capture, Settings, SettingsPatch, ViewportMetadata } from '../shared/schemas';
import { IDENTITY_TRANSFORM, transformDistance, zoomViewAbout, type ViewTransform } from '../shared/view-transform';
import { computeRegionGrid, findFigmaCanvas, isFigmaReady, readFigmaPage, readFigmaZoom, switchFigmaPage } from './figma-dom';
import { createOverlayHost, waitForPaint, type OverlayHost } from './overlay-host';
import { OverlayApp } from './OverlayApp';
import { ViewTracker, type ViewState } from './view-tracker';

export interface NoticeAction {
  label: string;
  primary?: boolean;
  run: () => void;
}

export interface Notice {
  id: 'viewport' | 'file-changed' | 'error' | 'info' | 'restored' | 'lost';
  tone: 'warn' | 'error' | 'info';
  text: string;
  actions: NoticeAction[];
}

export interface OverlayUiState {
  mode: OverlayMode;
  capture: Capture | null;
  saveStatus: SaveStatus;
  notice: Notice | null;
  busy: boolean;
  viewport: LiveViewport;
  /** Object URL of the capture screenshot, shown faintly to check alignment. */
  reference: string | null;
  toolbarPosition: { x: number; y: number } | null;
  /** Where the capture's marks are drawn relative to their capture position. */
  view: ViewState;
  /** Setting: keep marks attached to the design while Figma is panned/zoomed. */
  followView: boolean;
  /** Following, but every mark is outside the visible canvas (offer to go back to them). */
  marksOffscreen: boolean;
  /** Global shortcuts as currently configured in Chrome (for tooltips). */
  shortcuts: Shortcuts;
}

/** Events that must not leak from our UI into Figma's listeners. */
const ISOLATED_EVENTS = [
  'pointerdown',
  'pointerup',
  'pointermove',
  'pointercancel',
  'pointerover',
  'pointerout',
  'mousedown',
  'mouseup',
  'mousemove',
  'mouseover',
  'mouseout',
  'click',
  'dblclick',
  'auxclick',
  'contextmenu',
  'touchstart',
  'touchmove',
  'touchend',
  'touchcancel',
  'keydown',
  'keyup',
  'keypress',
  'input',
  'beforeinput',
  'paste',
  'copy',
  'cut',
  'focusin',
  'focusout',
  'compositionstart',
  'compositionupdate',
  'compositionend',
  'dragstart',
  'selectstart',
] as const;

function readLiveViewport(): LiveViewport {
  return { width: window.innerWidth, height: window.innerHeight, devicePixelRatio: window.devicePixelRatio };
}

function readViewportMetadata(overlayRoot: HTMLElement): ViewportMetadata {
  const vv = window.visualViewport;
  const canvas = findFigmaCanvas();
  return {
    figmaZoom: readFigmaZoom(),
    figmaPage: readFigmaPage(),
    regionGrid: canvas ? computeRegionGrid(canvas, overlayRoot) : null,
    pageUrl: location.href,
    pageTitle: document.title || null,
    viewportCssWidth: window.innerWidth,
    viewportCssHeight: window.innerHeight,
    devicePixelRatio: window.devicePixelRatio,
    scrollX: window.scrollX,
    scrollY: window.scrollY,
    visualViewportScale: vv?.scale ?? null,
    visualViewportOffsetLeft: vv?.offsetLeft ?? null,
    visualViewportOffsetTop: vv?.offsetTop ?? null,
  };
}

function projectKeyFromUrl(url: string): string | null {
  const parsed = parseFigmaUrl(url);
  return parsed ? projectKeyFor(parsed) : null;
}

/** Centre (CSS px) of the Figma canvas area recorded with a capture. */
function captureCanvasCenter(capture: Capture): { x: number; y: number } {
  const grid = capture.regionGrid;
  const cells = grid ? decodeRegionGrid(grid) : null;
  if (grid && cells) {
    let c0 = Infinity;
    let c1 = -1;
    let r0 = Infinity;
    let r1 = -1;
    for (let row = 0; row < grid.rows; row++) {
      for (let col = 0; col < grid.cols; col++) {
        if (!cells[row * grid.cols + col]) continue;
        c0 = Math.min(c0, col);
        c1 = Math.max(c1, col);
        r0 = Math.min(r0, row);
        r1 = Math.max(r1, row);
      }
    }
    if (c1 >= 0) return { x: ((c0 + c1 + 1) / 2) * grid.cell, y: ((r0 + r1 + 1) / 2) * grid.cell };
  }
  return { x: capture.viewportCssWidth / 2, y: capture.viewportCssHeight / 2 };
}

/** Dispatch a synthetic wheel event on Figma's canvas (Figma handles these like real ones). */
function dispatchCanvasWheel(
  canvas: HTMLCanvasElement,
  init: { deltaX?: number; deltaY?: number; ctrlKey?: boolean; clientX: number; clientY: number },
): void {
  canvas.dispatchEvent(
    new WheelEvent('wheel', { bubbles: true, cancelable: true, composed: true, deltaMode: 0, ...init }),
  );
}

function isExtensionContextValid(): boolean {
  try {
    return Boolean(chrome.runtime?.id);
  } catch {
    return false;
  }
}

function friendlyCaptureError(error: unknown): string {
  const message = errorMessage(error);
  if (/activeTab|all_urls|permission/i.test(message)) {
    return `Chrome needs a fresh click on the extension icon (or ${DEFAULT_SHORTCUTS.activate}) before it can capture this tab.`;
  }
  return `Capture failed: ${message}`;
}

export class OverlayController {
  readonly editorId = createId();
  readonly store: EditorStore;
  private readonly autosaver: Autosaver;
  private readonly host: OverlayHost;
  private readonly root: Root;
  private ui: OverlayUiState;
  private readonly listeners = new Set<() => void>();
  private readonly cleanups: (() => void)[] = [];
  private keyGuardInstalled = false;
  private dismissedViewportSignature: string | null = null;
  private fileChangeHandledFor: string | null = null;
  private lastVisibleMode: 'browse' | 'annotate' = 'browse';
  private settingsTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSettings: Pick<Settings, 'tool' | 'color' | 'size' | 'fontSize'> | null = null;
  private noticeTimer: ReturnType<typeof setTimeout> | null = null;
  private hasShownCaptureTip = false;
  private alive = true;
  private readonly tracker: ViewTracker;
  private readonly liveListeners = new Set<() => void>();
  /** "Open in Figma": once the captured area is found, go to the captured view. */
  private pendingGoToView = false;
  private flight: number | null = null;
  /** Where the last "go to captured view" aimed, until a check confirms we got there. */
  private flightTarget: ViewTransform | null = null;
  private flightCorrections = 0;
  private lastUrl = location.href;

  constructor() {
    this.store = new EditorStore();
    this.ui = {
      mode: 'closed',
      capture: null,
      saveStatus: { state: 'idle' },
      notice: null,
      busy: false,
      viewport: readLiveViewport(),
      reference: null,
      toolbarPosition: null,
      view: { transform: IDENTITY_TRANSFORM, status: 'off' },
      followView: true,
      marksOffscreen: false,
      shortcuts: { ...DEFAULT_SHORTCUTS },
    };

    this.autosaver = new Autosaver(
      this.store,
      async (captureId, annotations) => {
        await this.send({ type: 'ANNOTATIONS_SAVE', captureId, editorId: this.editorId, annotations });
      },
      (saveStatus) => this.onSaveStatus(saveStatus),
    );

    this.host = createOverlayHost(`${editorCss}\n${overlayCss}`);
    this.tracker = new ViewTracker({
      overlayRoot: this.host.container,
      host: this.host.host,
      isTracking: () =>
        this.ui.followView && this.ui.capture !== null && (this.ui.mode === 'browse' || this.ui.mode === 'annotate'),
      keysReachFigma: () => this.ui.mode !== 'annotate',
      followEnabled: () => this.ui.followView && this.alive,
      zoomCanvas: (factor) => this.zoomCanvas(factor),
      captureZoom: () => this.ui.capture?.figmaZoom ?? null,
      captureSize: () =>
        this.ui.capture ? { width: this.ui.capture.viewportCssWidth, height: this.ui.capture.viewportCssHeight } : null,
      onChange: (view) => this.onViewChange(view),
      onConfirmed: (transform) => this.onViewConfirmed(transform),
      onLive: (transform) => {
        if (__E2E__) document.documentElement.dataset.donLive = JSON.stringify(transform);
        for (const listener of this.liveListeners) listener();
      },
      align: async (input) => {
        const capture = this.ui.capture;
        if (!capture) return { status: 'unavailable', reason: 'No capture' };
        await this.autosaver.flush();
        return this.send({
          type: 'VIEW_ALIGN',
          captureId: capture.id,
          seed: input.seed,
          inkVisible: input.inkVisible && this.ui.mode !== 'hidden',
          scaleHint: input.scaleHint,
          scaleTolerance: input.scaleTolerance,
          lockScale: input.lockScale,
          region: input.region,
          exclude: this.ownUiRects(),
          viewport: { width: window.innerWidth, height: window.innerHeight },
        });
      },
    });
    this.cleanups.push(() => this.tracker.dispose());
    this.cleanups.push(this.store.onCommit(() => this.updateMarksOffscreen()));
    this.installEventIsolation();
    this.installWindowListeners();

    this.root = createRoot(this.host.container);
    this.root.render(createElement(OverlayApp, { controller: this }));

    void this.loadSettings();
  }

  // -- React subscription ------------------------------------------------------

  getSnapshot = (): OverlayUiState => this.ui;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private setUi(patch: Partial<OverlayUiState>): void {
    this.ui = { ...this.ui, ...patch };
    for (const listener of this.listeners) listener();
  }

  isAlive(): boolean {
    return this.alive && this.host.host.isConnected && isExtensionContextValid();
  }

  // -- messaging ---------------------------------------------------------------

  private async send<T extends ContentRequest['type']>(
    message: Extract<ContentRequest, { type: T }>,
  ): Promise<ContentResponses[T]> {
    if (!isExtensionContextValid()) {
      this.teardown();
      throw new Error('The extension was reloaded or updated. Reload this tab to keep annotating.');
    }
    try {
      return await sendToBackground(message);
    } catch (error) {
      if (/context invalidated/i.test(errorMessage(error))) this.teardown();
      throw error;
    }
  }

  /** chrome.runtime.onMessage listener. Returns true to keep the channel open. */
  handleMessage = (
    raw: unknown,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response: unknown) => void,
  ): boolean => {
    if (sender.id !== chrome.runtime.id || sender.tab) return false; // only our service worker
    const parsed = tabCommandSchema.safeParse(raw);
    if (!parsed.success) return false;
    this.handleCommand(parsed.data)
      .then((data) => sendResponse(okEnvelope(data)))
      .catch((error: unknown) => sendResponse(errorEnvelope(error)));
    return true;
  };

  private status(): OverlayStatus {
    return { captureId: this.ui.capture?.id ?? null, mode: this.ui.mode };
  }

  private async handleCommand(command: TabCommand): Promise<TabResponses[TabCommand['type']]> {
    switch (command.type) {
      case 'PING':
        return this.status();
      case 'CAPTURE_START': {
        const capture = await this.takeCapture();
        return { captureId: capture.id };
      }
      case 'SET_MODE':
        this.setMode(command.mode);
        return this.status();
      case 'TOGGLE_ANNOTATE':
        this.setMode(this.ui.mode === 'annotate' ? 'browse' : 'annotate');
        return this.status();
      case 'TOGGLE_VISIBILITY':
        this.toggleVisibility();
        return this.status();
      case 'GET_VIEWPORT':
        return { ...readLiveViewport(), url: location.href };
      case 'SHOW_CAPTURE':
        await this.showCapture(command.captureId, command.goToView ?? false);
        return this.status();
      case 'CAPTURE_DELETED':
        if (command.captureId === null || command.captureId === this.ui.capture?.id) this.unloadDeletedCapture();
        return null;
      case 'CAPTURE_META_CHANGED':
        if (command.capture.id === this.ui.capture?.id) this.setUi({ capture: command.capture });
        return null;
      case 'ANNOTATIONS_CHANGED':
        await this.onExternalAnnotationChange(command.captureId, command.sourceId);
        return null;
      case 'SETTINGS_CHANGED':
        this.setFollowView(command.followView, false);
        return null;
    }
  }

  private reportState(): void {
    void this.send({ type: 'OVERLAY_STATE', ...this.status() }).catch(() => undefined);
  }

  // -- modes -------------------------------------------------------------------

  setMode(mode: OverlayMode): void {
    const previous = this.ui.mode;
    if (mode === previous) return;
    if (mode === 'annotate' && !this.ui.capture) {
      void this.takeCapture().catch(() => undefined);
      return;
    }
    if (previous === 'annotate') {
      this.store.finishTextEdit();
      this.store.select(null);
      void this.autosaver.flush();
      this.removeKeyGuard();
      this.blurOverlay();
    }
    if (mode === 'annotate') {
      this.installKeyGuard();
      // Move keyboard focus away from Figma so typing cannot reach it.
      requestAnimationFrame(() => this.host.container.focus({ preventScroll: true }));
    }
    if (mode === 'browse' || mode === 'annotate') {
      this.lastVisibleMode = mode;
      // Figma may have moved while the marks were hidden: check where they belong.
      if (previous === 'hidden') this.tracker.invalidate();
    }
    if (mode === 'closed') {
      void this.autosaver.flush();
      this.clearReference();
      if (this.ui.notice?.id !== 'error') this.setNotice(null);
    }
    this.setUi({ mode });
    this.reportState();
    if (mode === 'browse' || mode === 'annotate') this.evaluateViewportNotice();
  }

  toggleVisibility(): void {
    if (this.ui.mode === 'hidden') this.setMode(this.lastVisibleMode === 'annotate' ? 'browse' : this.lastVisibleMode);
    else if (this.ui.mode !== 'closed') this.setMode('hidden');
  }

  close(): void {
    this.setMode('closed');
  }

  // -- captures ----------------------------------------------------------------

  async takeCapture(): Promise<Capture> {
    if (this.ui.busy) throw new Error('A capture is already in progress');
    this.setUi({ busy: true });
    try {
      this.store.finishTextEdit();
      await this.autosaver.flush();
      // Never let our own UI or existing marks end up in the base screenshot.
      this.host.setRendered(false);
      await waitForPaint();
      const metadata = readViewportMetadata(this.host.container);
      const { capture } = await this.send({ type: 'CAPTURE_CREATE', metadata });
      this.store.load(capture.id, []);
      // A new capture is exactly where the view is now (identity): remember that.
      if (this.ui.followView && findFigmaCanvas()) this.tracker.reset('following', IDENTITY_TRANSFORM, capture.id, true);
      else this.tracker.reset('off');
      this.autosaver.markClean();
      this.dismissedViewportSignature = null;
      this.fileChangeHandledFor = null;
      this.clearReference();
      this.setUi({ capture, saveStatus: { state: 'idle' } });
      if (!this.hasShownCaptureTip) {
        this.hasShownCaptureTip = true;
        this.setNotice(
          {
            id: 'info',
            tone: 'info',
            text: this.ui.view.status === 'off'
              ? 'Captured this view. Marks belong to this capture — after panning or zooming Figma, take a new capture.'
              : 'Captured this view. Your marks stay attached to the design when you scroll or zoom Figma.',
            actions: [],
          },
          7_000,
        );
      } else if (this.ui.notice?.id !== 'error') {
        this.setNotice(null);
      }
      this.setMode('annotate');
      return capture;
    } catch (error) {
      this.setNotice({ id: 'error', tone: 'error', text: friendlyCaptureError(error), actions: [] });
      throw error;
    } finally {
      this.host.setRendered(true);
      this.setUi({ busy: false });
    }
  }

  /**
   * Show a saved capture's notes on this tab. With `goToView` ("Open in
   * Figma"), also bring Figma to the captured view: switch to the capture's
   * page, use the position known from earlier in this tab if any, otherwise
   * search the view (zooming out to find it), then fly to the captured view.
   */
  async showCapture(captureId: string, goToView = false): Promise<void> {
    this.store.finishTextEdit();
    await this.autosaver.flush();
    const following = this.ui.followView;
    const current = this.ui.capture;
    if (following && current?.id === captureId && this.ui.view.status === 'following' && this.ui.mode !== 'closed') {
      // Already shown and tracked (perhaps scrolled away): just go there.
      if (this.ui.mode === 'hidden') this.setMode('browse');
      if (goToView) this.goToCapturedView();
      return;
    }
    const { capture, annotations, lastView } = await this.send({ type: 'CAPTURE_LOAD', captureId });
    this.store.load(capture.id, annotations);
    this.autosaver.markClean();
    this.dismissedViewportSignature = null;
    this.fileChangeHandledFor = null;
    this.clearReference();
    this.setUi({ capture, saveStatus: { state: 'idle' } });
    if (this.ui.mode === 'browse') this.reportState();
    else this.setMode('browse');

    if (!following) {
      this.tracker.reset('off');
      const comparison = compareViewport(capture, readLiveViewport());
      if (comparison.status === 'match') {
        this.setNotice({
          id: 'restored',
          tone: 'info',
          text: `Showing “${capture.title}” over the live page. It only lines up if Figma shows exactly the same view.`,
          actions: [
            { label: 'Compare with capture', run: () => void this.toggleReference() },
            { label: 'Dismiss', run: () => this.setNotice(null) },
          ],
        });
      }
      return;
    }

    // Marks stay hidden ("Finding notes…") until their place is known.
    this.tracker.reset('searching', lastView ?? IDENTITY_TRANSFORM, capture.id);
    const justLoaded = await this.waitForFigma();
    await this.navigateToCapture({ goToView, explore: goToView, justLoaded });
  }

  /** Find the shown capture's area — its page, then a known position or a search — and go there. */
  findNotes(): void {
    if (!this.ui.capture || !this.ui.followView) return;
    void this.navigateToCapture({ goToView: true, explore: true });
  }

  private async navigateToCapture(options: { goToView: boolean; explore: boolean; justLoaded?: boolean }): Promise<void> {
    const capture = this.ui.capture;
    if (!capture) return;
    if (options.goToView && capture.figmaPage && readFigmaPage() !== capture.figmaPage) {
      await this.goToFigmaPage(capture.figmaPage);
    }
    if (this.ui.capture?.id !== capture.id) return; // another capture was requested meanwhile
    const predicted = this.tracker.predictedFor(capture.id);
    if (predicted) {
      // Found earlier in this tab and the view was tracked since: instant.
      this.tracker.reset('following', predicted, capture.id);
      if (options.goToView) requestAnimationFrame(() => this.goToCapturedView());
      else this.tracker.verifySoon();
      return;
    }
    this.pendingGoToView = options.goToView;
    const found = await this.tracker.locate({ explore: options.explore, justLoaded: options.justLoaded });
    if (!found) this.pendingGoToView = false;
  }

  /** Wait until Figma shows its canvas (a freshly opened tab). Returns whether it was still loading. */
  private async waitForFigma(): Promise<boolean> {
    if (isFigmaReady()) return false;
    for (let waited = 0; waited < 20_000 && !isFigmaReady(); waited += 200) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return true;
  }

  /** Open another Figma page via its row in the Pages panel and wait for the switch. */
  private async goToFigmaPage(name: string): Promise<void> {
    if (!switchFigmaPage(name)) return;
    for (let waited = 0; waited < 3_000 && readFigmaPage() !== name; waited += 100) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    // Let Figma draw the page, then let the tracker pick up the page's frame.
    await new Promise((resolve) => setTimeout(resolve, 350));
    this.checkFileChange();
  }

  /** Zoom Figma's canvas around its centre with synthetic Ctrl+wheel input (Figma's linear zone). */
  private async zoomCanvas(factor: number): Promise<void> {
    const canvas = findFigmaCanvas();
    if (!canvas || !(factor > 0)) return;
    const rect = canvas.getBoundingClientRect();
    const c = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    let deltaY = -Math.log(factor) / 0.005;
    while (Math.abs(deltaY) > 1e-3) {
      const d = Math.max(-30, Math.min(30, deltaY));
      dispatchCanvasWheel(canvas, { deltaY: d, ctrlKey: true, clientX: c.x, clientY: c.y });
      deltaY -= d;
    }
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }

  private unloadDeletedCapture(): void {
    this.tracker.reset('off');
    this.store.load(null, []);
    this.autosaver.markClean();
    this.clearReference();
    this.setUi({ capture: null, saveStatus: { state: 'idle' } });
    this.setMode('closed');
    this.setNotice({ id: 'info', tone: 'info', text: 'This capture was deleted in the notes manager.', actions: [] }, 5_000);
  }

  private async onExternalAnnotationChange(captureId: string, sourceId: string | undefined): Promise<void> {
    if (captureId !== this.ui.capture?.id || sourceId === this.editorId) return;
    if (this.autosaver.isDirty() || this.store.getState().editing) return; // local edits win on next save
    const { capture, annotations } = await this.send({ type: 'CAPTURE_LOAD', captureId });
    if (this.autosaver.isDirty()) return;
    this.store.replaceFromExternal(annotations);
    this.autosaver.markClean();
    this.setUi({ capture });
  }

  // -- saving ------------------------------------------------------------------------

  private onSaveStatus(saveStatus: SaveStatus): void {
    const failedBefore = this.ui.saveStatus.state === 'error';
    this.setUi({ saveStatus });
    if (saveStatus.state === 'error' && !failedBefore) {
      // Make a failing save impossible to miss (the toolbar label alone is easy to overlook).
      this.setNotice({
        id: 'error',
        tone: 'error',
        text: `Your latest marks are not saved yet (${saveStatus.message}). Retrying automatically — keep this tab open. If it keeps failing, export a backup from the notes manager.`,
        actions: [{ label: 'Open notes manager', run: () => this.openPanel() }],
      });
    } else if (saveStatus.state === 'saved' && failedBefore && this.ui.notice?.id === 'error') {
      this.setNotice({ id: 'info', tone: 'info', text: 'Saved again.', actions: [] }, 3_000);
    }
  }

  // -- view tracking ---------------------------------------------------------------

  /** Latest predicted view transform (changes every frame while Figma moves). */
  getLiveTransform = () => this.tracker.getLive();

  /** Notified on every live transform change; the canvas applies it without re-rendering. */
  subscribeLive = (listener: () => void): (() => void) => {
    this.liveListeners.add(listener);
    return () => this.liveListeners.delete(listener);
  };

  private onViewChange(view: ViewState): void {
    const previous = this.ui.view;
    this.setUi({ view });
    this.updateMarksOffscreen();
    if (__E2E__) document.documentElement.dataset.donView = JSON.stringify({ ...view.transform, status: view.status });
    this.store.setViewScale(view.transform.s);
    if (view.status === previous.status) return;
    if (view.status === 'following' && this.pendingGoToView) {
      this.pendingGoToView = false;
      requestAnimationFrame(() => this.goToCapturedView());
    }
    if (view.status === 'lost') {
      this.pendingGoToView = false;
      this.store.finishTextEdit();
      this.setNotice({
        id: 'lost',
        tone: 'warn',
        text: 'Couldn’t find the area of these notes in the current view.',
        actions: [
          { label: 'Find notes', primary: true, run: () => this.findNotes() },
          { label: 'View as image', run: () => this.openReview() },
        ],
      });
    } else if (this.ui.notice?.id === 'lost') {
      this.setNotice(null);
    }
    this.evaluateViewportNotice();
  }

  /**
   * Scroll and zoom Figma back to the captured view: the captured area at its
   * captured zoom, centred in today's canvas. Done with the same wheel input a
   * user would give (Figma's measured response), animated over a few frames;
   * the tracker follows each step and confirms the result afterwards.
   */
  goToCapturedView(correction = false): void {
    const capture = this.ui.capture;
    const canvas = findFigmaCanvas();
    if (!capture || !canvas || this.ui.view.status !== 'following') return;
    if (this.flight !== null) cancelAnimationFrame(this.flight);
    if (!correction) this.flightCorrections = 0;
    const rect = canvas.getBoundingClientRect();
    const c = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    const capturedCenter = captureCanvasCenter(capture);
    const start = this.tracker.getLive();
    let target: ViewTransform = { s: 1, tx: c.x - capturedCenter.x, ty: c.y - capturedCenter.y };
    // Same window layout as when captured: restore the exact captured view
    // (the centre estimate above is only accurate to a region-grid cell).
    const sameLayout =
      Math.abs(window.innerWidth - capture.viewportCssWidth) < 2 &&
      Math.abs(window.innerHeight - capture.viewportCssHeight) < 2 &&
      Math.hypot(target.tx, target.ty) < (capture.regionGrid?.cell ?? 16);
    if (sameLayout) target = { s: 1, tx: 0, ty: 0 };
    // A short hop for a final correction, a visible glide otherwise.
    const frames = correction ? 3 : 14;
    let frame = 0;
    let current = start;
    const step = () => {
      frame++;
      const k = 1 - (1 - frame / frames) ** 3; // ease-out
      const s = Math.exp(Math.log(start.s) + (Math.log(target.s) - Math.log(start.s)) * k);
      // Zoom part: Figma's Ctrl+wheel is linear (ln factor = −0.005·Δ) for |Δ| ≤ 30.
      let deltaY = -Math.log(s / current.s) / 0.005;
      while (Math.abs(deltaY) > 1e-3) {
        const d = Math.max(-30, Math.min(30, deltaY));
        dispatchCanvasWheel(canvas, { deltaY: d, ctrlKey: true, clientX: c.x, clientY: c.y });
        current = zoomViewAbout(current, Math.exp(-0.005 * d), c.x, c.y);
        deltaY -= d;
      }
      // Pan part: Figma pans by −Δ, at most 120 px per event.
      const wantTx = frame === frames ? target.tx : start.tx + (target.tx - start.tx) * k;
      const wantTy = frame === frames ? target.ty : start.ty + (target.ty - start.ty) * k;
      let dx = wantTx - current.tx;
      let dy = wantTy - current.ty;
      while (Math.abs(dx) > 0.01 || Math.abs(dy) > 0.01) {
        const px = Math.max(-100, Math.min(100, dx));
        const py = Math.max(-100, Math.min(100, dy));
        dispatchCanvasWheel(canvas, { deltaX: -px, deltaY: -py, clientX: c.x, clientY: c.y });
        current = { s: current.s, tx: current.tx + px, ty: current.ty + py };
        dx -= px;
        dy -= py;
      }
      this.flight = frame < frames ? requestAnimationFrame(step) : null;
      if (this.flight === null) this.flightTarget = target;
    };
    this.flight = requestAnimationFrame(step);
  }

  /**
   * After a flight, the follow-up check tells where we really are. The found
   * position can be slightly off (found while zoomed far out); one small
   * exact correction makes Figma show exactly the captured view.
   */
  private onViewConfirmed(transform: ViewTransform): void {
    const target = this.flightTarget;
    if (!target || this.flight !== null) return;
    this.flightTarget = null;
    const off = transformDistance(transform, target, window.innerWidth, window.innerHeight);
    if (off > 1 && off < 120 && this.flightCorrections < 1) {
      this.flightCorrections++;
      requestAnimationFrame(() => this.goToCapturedView(true));
    }
  }

  /** Are all marks outside the visible canvas under the committed view? */
  private updateMarksOffscreen(): void {
    const { view } = this.ui;
    const annotations = this.store.getState().annotations;
    let offscreen = false;
    if (view.status === 'following' && annotations.length > 0) {
      const measure = getTextMeasurer();
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (const annotation of annotations) {
        const b = annotationBounds(annotation, measure);
        x0 = Math.min(x0, b.x);
        y0 = Math.min(y0, b.y);
        x1 = Math.max(x1, b.x + b.width);
        y1 = Math.max(y1, b.y + b.height);
      }
      const t = view.transform;
      const area = findFigmaCanvas()?.getBoundingClientRect() ?? new DOMRect(0, 0, window.innerWidth, window.innerHeight);
      const left = t.s * x0 + t.tx;
      const top = t.s * y0 + t.ty;
      const right = t.s * x1 + t.tx;
      const bottom = t.s * y1 + t.ty;
      offscreen = right < area.left || left > area.right || bottom < area.top || top > area.bottom;
    }
    if (offscreen !== this.ui.marksOffscreen) this.setUi({ marksOffscreen: offscreen });
  }

  setFollowView(followView: boolean, persist = true): void {
    if (followView === this.ui.followView) return;
    this.setUi({ followView });
    if (persist) this.saveSettingsSoon({ followView });
    if (!this.ui.capture) return;
    if (followView && findFigmaCanvas()) {
      this.tracker.reset('searching', this.ui.view.transform, this.ui.capture.id);
      void this.tracker.locate({ explore: false });
    } else {
      this.tracker.reset('off');
    }
    if (this.ui.notice?.id === 'lost') this.setNotice(null);
  }

  /** Our own toolbar/banners and the drawing-mode frame, in live CSS px. */
  private ownUiRects(): { x: number; y: number; width: number; height: number }[] {
    const rects: { x: number; y: number; width: number; height: number }[] = [];
    for (const el of this.host.container.querySelectorAll('.don-floating > *')) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) rects.push({ x: r.x, y: r.y, width: r.width, height: r.height });
    }
    const frame = 6;
    rects.push(
      { x: 0, y: 0, width: window.innerWidth, height: frame },
      { x: 0, y: window.innerHeight - frame, width: window.innerWidth, height: frame },
      { x: 0, y: 0, width: frame, height: window.innerHeight },
      { x: window.innerWidth - frame, y: 0, width: frame, height: window.innerHeight },
    );
    return rects;
  }

  // -- reference image -----------------------------------------------------------

  async toggleReference(): Promise<void> {
    if (this.ui.reference) {
      this.clearReference();
      return;
    }
    const capture = this.ui.capture;
    if (!capture) return;
    try {
      const { dataUrl } = await this.send({ type: 'SCREENSHOT_GET', captureId: capture.id });
      this.setUi({ reference: URL.createObjectURL(dataUrlToBlob(dataUrl)) });
    } catch (error) {
      this.setNotice({ id: 'error', tone: 'error', text: `Could not load the capture image: ${errorMessage(error)}`, actions: [] }, 6_000);
    }
  }

  private clearReference(): void {
    if (this.ui.reference) {
      URL.revokeObjectURL(this.ui.reference);
      this.setUi({ reference: null });
    }
  }

  // -- notices -----------------------------------------------------------------

  setNotice(notice: Notice | null, autoDismissMs?: number): void {
    if (this.noticeTimer) {
      clearTimeout(this.noticeTimer);
      this.noticeTimer = null;
    }
    this.setUi({ notice });
    if (notice && autoDismissMs) {
      this.noticeTimer = setTimeout(() => {
        if (this.ui.notice === notice) this.setUi({ notice: null });
      }, autoDismissMs);
    }
  }

  dismissNotice(): void {
    const notice = this.ui.notice;
    if (notice?.id === 'viewport' && this.ui.capture) {
      const comparison = compareViewport(this.ui.capture, readLiveViewport());
      if (comparison.status === 'mismatch') this.dismissedViewportSignature = comparison.reasons.join('|');
    }
    this.setNotice(null);
  }

  private evaluateViewportNotice(): void {
    const capture = this.ui.capture;
    if (!capture || this.ui.mode === 'closed') return;
    const current = this.ui.notice;
    if (this.ui.view.status !== 'off') {
      // Marks follow the design; a different window size or zoom is fine.
      if (current?.id === 'viewport') this.setNotice(null);
      return;
    }
    const comparison = compareViewport(capture, readLiveViewport());
    if (comparison.status === 'match') {
      if (current?.id === 'viewport') this.setNotice(null);
      return;
    }
    const signature = comparison.reasons.join('|');
    if (signature === this.dismissedViewportSignature) return;
    if (current && current.id !== 'viewport' && current.id !== 'info' && current.id !== 'restored') return;
    this.setNotice({
      id: 'viewport',
      tone: 'warn',
      text: `${comparison.reasons.join('. ')}. Marks may no longer line up with the design.`,
      actions: [
        { label: 'New capture', primary: true, run: () => void this.takeCapture().catch(() => undefined) },
        { label: 'Compare', run: () => void this.toggleReference() },
      ],
    });
  }

  private checkFileChange = (): void => {
    if (location.href !== this.lastUrl) {
      const previousKey = projectKeyFromUrl(this.lastUrl);
      this.lastUrl = location.href;
      // Same file, different page/selection: the canvas may show something else now.
      this.tracker.invalidate();
      // Keep the service worker's tab → file map current (used to reuse tabs).
      if (projectKeyFromUrl(location.href) !== previousKey) this.reportState();
    }
    const capture = this.ui.capture;
    if (!capture || this.ui.mode === 'closed') return;
    const live = parseFigmaUrl(location.href);
    const captured = parseFigmaUrl(capture.pageUrl);
    const liveKey = live ? projectKeyFor(live) : location.pathname;
    const capturedKey = captured ? projectKeyFor(captured) : null;
    if (liveKey === capturedKey) {
      this.fileChangeHandledFor = null;
      return;
    }
    if (this.fileChangeHandledFor === liveKey) return;
    this.fileChangeHandledFor = liveKey;
    this.setMode('hidden');
    this.setNotice({
      id: 'file-changed',
      tone: 'warn',
      text: `This tab now shows a different Figma file. Notes for “${capture.title}” are hidden.`,
      actions: [
        { label: 'New capture', primary: true, run: () => void this.takeCapture().catch(() => undefined) },
        {
          label: 'Show anyway',
          run: () => {
            this.setNotice(null);
            this.setMode('browse');
          },
        },
      ],
    });
  };

  // -- panel / review ----------------------------------------------------------

  openPanel(): void {
    // Must be sent during the click so Chrome treats it as a user gesture.
    void this.send({ type: 'OPEN_SIDE_PANEL' }).catch((error: unknown) =>
      this.setNotice({ id: 'error', tone: 'error', text: errorMessage(error), actions: [] }, 6_000),
    );
  }

  openReview(): void {
    const capture = this.ui.capture;
    if (!capture) return;
    void this.autosaver.flush().then(() => this.send({ type: 'OPEN_REVIEW', captureId: capture.id }));
  }

  // -- settings ----------------------------------------------------------------

  private async loadSettings(): Promise<void> {
    try {
      const { settings, shortcuts } = await this.send({ type: 'SETTINGS_GET' });
      this.setUi({ shortcuts });
      const { tool, color, size, fontSize, followView } = settings;
      this.setUi({ followView });
      this.store.setTool(tool);
      this.store.setColor(color);
      this.store.setSize(size);
      this.store.setFontSize(fontSize);
      this.lastSettings = { tool, color, size, fontSize };
      this.setUi({ toolbarPosition: settings.toolbarPosition });
    } catch {
      // Defaults are fine.
    }
    const unsubscribe = this.store.subscribe(() => this.persistToolSettingsSoon());
    this.cleanups.push(unsubscribe);
  }

  private persistToolSettingsSoon(): void {
    const { tool, color, size, fontSize } = this.store.getState();
    const last = this.lastSettings;
    if (last && last.tool === tool && last.color === color && last.size === size && last.fontSize === fontSize) return;
    this.lastSettings = { tool, color, size, fontSize };
    this.saveSettingsSoon({ tool, color, size, fontSize });
  }

  private pendingSettings: SettingsPatch = {};

  private saveSettingsSoon(patch: SettingsPatch): void {
    this.pendingSettings = { ...this.pendingSettings, ...patch };
    if (this.settingsTimer) clearTimeout(this.settingsTimer);
    this.settingsTimer = setTimeout(() => {
      const toSave = this.pendingSettings;
      this.pendingSettings = {};
      void this.send({ type: 'SETTINGS_SET', patch: toSave }).catch(() => undefined);
    }, 600);
  }

  setToolbarPosition(position: { x: number; y: number } | null, persist: boolean): void {
    this.setUi({ toolbarPosition: position });
    if (persist) this.saveSettingsSoon({ toolbarPosition: position });
  }

  // -- isolation from Figma ------------------------------------------------------

  private installEventIsolation(): void {
    const host = this.host.host;
    const stop = (e: Event) => e.stopPropagation();
    for (const type of ISOLATED_EVENTS) host.addEventListener(type, stop);
    host.addEventListener(
      'wheel',
      (e) => {
        e.stopPropagation();
        if (this.ui.mode !== 'annotate') return;
        e.preventDefault();
        // While marks follow the design, let scrolling/zooming reach Figma's
        // canvas even in drawing mode (the view tracker sees the forwarded event).
        if (this.ui.view.status === 'following' && !this.isOverOwnUi(e)) this.forwardWheel(e);
      },
      { passive: false },
    );
  }

  private isOverOwnUi(e: Event): boolean {
    return e.composedPath().some((node) => node instanceof Element && node.classList.contains('don-floating'));
  }

  private forwardWheel(e: WheelEvent): void {
    const canvas = findFigmaCanvas();
    if (!canvas) return;
    canvas.dispatchEvent(
      new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        composed: true,
        clientX: e.clientX,
        clientY: e.clientY,
        screenX: e.screenX,
        screenY: e.screenY,
        deltaX: e.deltaX,
        deltaY: e.deltaY,
        deltaZ: e.deltaZ,
        deltaMode: e.deltaMode,
        ctrlKey: e.ctrlKey,
        shiftKey: e.shiftKey,
        altKey: e.altKey,
        metaKey: e.metaKey,
        buttons: e.buttons,
      }),
    );
  }

  private isFromOverlay(e: Event): boolean {
    return e.composedPath().includes(this.host.host);
  }

  /** Window capture-phase guard: in annotate mode Figma must not see keys. */
  private onKeyCapture = (e: KeyboardEvent): void => {
    if (this.ui.mode !== 'annotate') return;
    const fromOverlay = this.isFromOverlay(e);
    if (e.type === 'keydown') {
      const handled = handleEditorKeydown(e, this.store, { onExit: () => this.setMode('browse') });
      if (handled) e.preventDefault();
      else if (!fromOverlay && !e.ctrlKey && !e.metaKey && !/^F\d+$/.test(e.key)) e.preventDefault();
    }
    e.stopImmediatePropagation();
  };

  private onClipboardCapture = (e: ClipboardEvent): void => {
    if (this.ui.mode !== 'annotate') return;
    const editingHere = this.store.getState().editing !== null && this.isFromOverlay(e);
    if (!editingHere) e.preventDefault();
    e.stopImmediatePropagation();
  };

  private installKeyGuard(): void {
    if (this.keyGuardInstalled) return;
    this.keyGuardInstalled = true;
    for (const type of ['keydown', 'keyup', 'keypress'] as const) {
      window.addEventListener(type, this.onKeyCapture, true);
    }
    for (const type of ['paste', 'copy', 'cut'] as const) {
      window.addEventListener(type, this.onClipboardCapture, true);
    }
  }

  private removeKeyGuard(): void {
    if (!this.keyGuardInstalled) return;
    this.keyGuardInstalled = false;
    for (const type of ['keydown', 'keyup', 'keypress'] as const) {
      window.removeEventListener(type, this.onKeyCapture, true);
    }
    for (const type of ['paste', 'copy', 'cut'] as const) {
      window.removeEventListener(type, this.onClipboardCapture, true);
    }
  }

  private blurOverlay(): void {
    const active = this.host.shadow.activeElement;
    if (active instanceof HTMLElement || active instanceof SVGElement) active.blur();
  }

  private installWindowListeners(): void {
    const onResize = () => {
      this.setUi({ viewport: readLiveViewport() });
      this.evaluateViewportNotice();
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        this.store.finishTextEdit();
        void this.autosaver.flush();
      }
    };
    const onPageHide = () => void this.autosaver.flush();
    // Real input during "go to captured view" takes over from the animation.
    const abortFlight = (e: Event) => {
      if (e.isTrusted && this.flight !== null) {
        cancelAnimationFrame(this.flight);
        this.flight = null;
      }
    };
    for (const type of ['wheel', 'pointerdown', 'keydown'] as const) {
      window.addEventListener(type, abortFlight, { capture: true, passive: true });
    }
    window.addEventListener('resize', onResize);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onPageHide);

    // Figma is a single-page app: watch for file changes without patching history.
    const nav = (window as Window & { navigation?: EventTarget }).navigation;
    nav?.addEventListener('currententrychange', this.checkFileChange);
    const interval = setInterval(this.checkFileChange, 1_500);

    this.cleanups.push(() => {
      window.removeEventListener('resize', onResize);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPageHide);
      for (const type of ['wheel', 'pointerdown', 'keydown'] as const) {
        window.removeEventListener(type, abortFlight, { capture: true });
      }
      nav?.removeEventListener('currententrychange', this.checkFileChange);
      clearInterval(interval);
    });
  }

  /** Remove everything (extension reloaded/updated: this script is orphaned). */
  teardown(): void {
    if (!this.alive) return;
    this.alive = false;
    this.removeKeyGuard();
    this.autosaver.dispose();
    for (const cleanup of this.cleanups) cleanup();
    try {
      chrome.runtime.onMessage.removeListener(this.handleMessage);
    } catch {
      // Context already gone.
    }
    this.root.unmount();
    this.host.destroy();
  }
}
