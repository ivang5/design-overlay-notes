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
import { handleEditorKeydown } from '../editor/keyboard';
import { EditorStore } from '../editor/store';
import type { SaveStatus } from '../editor/Toolbar';
import { DEFAULT_SHORTCUTS } from '../shared/constants';
import { compareViewport, type LiveViewport } from '../shared/coordinates';
import { dataUrlToBlob } from '../shared/binary';
import { parseFigmaUrl, projectKeyFor } from '../shared/figma-url';
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
  type TabCommand,
  type TabResponses,
} from '../shared/messages';
import type { Capture, Settings, SettingsPatch, ViewportMetadata } from '../shared/schemas';
import { createOverlayHost, waitForPaint, type OverlayHost } from './overlay-host';
import { OverlayApp } from './OverlayApp';

export interface NoticeAction {
  label: string;
  primary?: boolean;
  run: () => void;
}

export interface Notice {
  id: 'viewport' | 'file-changed' | 'error' | 'info' | 'restored';
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

function readViewportMetadata(): ViewportMetadata {
  const vv = window.visualViewport;
  return {
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
  private lastSettings: Pick<Settings, 'tool' | 'color' | 'size'> | null = null;
  private noticeTimer: ReturnType<typeof setTimeout> | null = null;
  private hasShownCaptureTip = false;
  private alive = true;

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
    };

    this.autosaver = new Autosaver(
      this.store,
      async (captureId, annotations) => {
        await this.send({ type: 'ANNOTATIONS_SAVE', captureId, editorId: this.editorId, annotations });
      },
      (saveStatus) => this.setUi({ saveStatus }),
    );

    this.host = createOverlayHost(`${editorCss}\n${overlayCss}`);
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
        await this.showCapture(command.captureId);
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
    if (mode === 'browse' || mode === 'annotate') this.lastVisibleMode = mode;
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
      const metadata = readViewportMetadata();
      const { capture } = await this.send({ type: 'CAPTURE_CREATE', metadata });
      this.store.load(capture.id, []);
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
            text: 'Captured this view. Marks belong to this capture — after panning or zooming Figma, take a new capture.',
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

  async showCapture(captureId: string): Promise<void> {
    this.store.finishTextEdit();
    await this.autosaver.flush();
    const { capture, annotations } = await this.send({ type: 'CAPTURE_LOAD', captureId });
    this.store.load(capture.id, annotations);
    this.autosaver.markClean();
    this.dismissedViewportSignature = null;
    this.fileChangeHandledFor = null;
    this.clearReference();
    this.setUi({ capture, saveStatus: { state: 'idle' } });
    if (this.ui.mode === 'browse') this.reportState();
    else this.setMode('browse');
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
  }

  private unloadDeletedCapture(): void {
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
      const { settings } = await this.send({ type: 'SETTINGS_GET' });
      const { tool, color, size } = settings;
      this.store.setTool(tool);
      this.store.setColor(color);
      this.store.setSize(size);
      this.lastSettings = { tool, color, size };
      this.setUi({ toolbarPosition: settings.toolbarPosition });
    } catch {
      // Defaults are fine.
    }
    const unsubscribe = this.store.subscribe(() => this.persistToolSettingsSoon());
    this.cleanups.push(unsubscribe);
  }

  private persistToolSettingsSoon(): void {
    const { tool, color, size } = this.store.getState();
    const last = this.lastSettings;
    if (last && last.tool === tool && last.color === color && last.size === size) return;
    this.lastSettings = { tool, color, size };
    this.saveSettingsSoon({ tool, color, size });
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
        if (this.ui.mode === 'annotate') e.preventDefault();
      },
      { passive: false },
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
