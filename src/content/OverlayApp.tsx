import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import {
  Camera,
  Check,
  Eye,
  EyeOff,
  Focus,
  GripVertical,
  Layers,
  LocateFixed,
  LocateOff,
  PanelRight,
  Pencil,
  X,
} from 'lucide-react';
import { AnnotationCanvas } from '../editor/AnnotationCanvas';
import { viewBoxFor, type ViewTransform } from '../shared/view-transform';
import { Divider, SaveIndicator, ToolButton, ToolbarShell, ToolControls } from '../editor/Toolbar';
import type { Notice, OverlayController, OverlayUiState } from './controller';
import { findFigmaCanvas } from './figma-dom';

const EDGE_MARGIN = 8;

const withShortcut = (label: string, shortcut: string) => (shortcut ? `${label} (${shortcut})` : label);

export function OverlayApp({ controller }: { controller: OverlayController }) {
  const ui = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const { mode, capture, viewport, view } = ui;
  // While the capture's area is being searched for (or is out of view), marks are hidden.
  const placed = view.status === 'off' || view.status === 'following';
  const showCanvas = capture !== null && (mode === 'browse' || mode === 'annotate') && placed;

  // The SVG renders with the committed transform (viewBox). Predictions made
  // while Figma moves are applied on top as a CSS transform of the SVG layer:
  // the compositor moves it in the same frame without re-rendering the marks.
  const svgRef = useRef<SVGSVGElement | null>(null);
  const clipRef = useRef<HTMLDivElement | null>(null);
  // Figma's canvas rectangle, re-read at most every 300 ms (live updates come per wheel event).
  const canvasRectRef = useRef<{ rect: DOMRect | null; at: number }>({ rect: null, at: 0 });
  const committedRef = useRef<ViewTransform>(view.transform);
  committedRef.current = view.transform;
  const applyLive = useCallback(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const live = controller.getLiveTransform();
    const committed = committedRef.current;
    const k = live.s / committed.s;
    const dx = live.tx - k * committed.tx;
    const dy = live.ty - k * committed.ty;
    const identity = Math.abs(k - 1) < 1e-6 && Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01;
    svg.style.transform = identity ? '' : `matrix(${k}, 0, 0, ${k}, ${dx}, ${dy})`;
    // Once Figma's view moved, marks carried off the canvas must not cover
    // Figma's panels: show them only over the canvas. (At the captured view,
    // marks drawn on a panel stay visible.) A mask, unlike clip-path, leaves
    // drawing input alone.
    const clip = clipRef.current;
    if (clip) {
      const moved = Math.abs(live.s - 1) > 0.002 || Math.hypot(live.tx, live.ty) > 2;
      const cached = canvasRectRef.current;
      if (moved && performance.now() - cached.at > 300) {
        canvasRectRef.current = { rect: findFigmaCanvas()?.getBoundingClientRect() ?? null, at: performance.now() };
      }
      const rect = moved ? canvasRectRef.current.rect : null;
      if (rect) {
        clip.style.setProperty('--don-clip-pos', `${rect.left}px ${rect.top}px`);
        clip.style.setProperty('--don-clip-size', `${rect.width}px ${rect.height}px`);
      }
      clip.classList.toggle('is-clipped', Boolean(rect));
    }
  }, [controller]);
  const setSvg = useCallback(
    (element: SVGSVGElement | null) => {
      svgRef.current = element;
      applyLive();
    },
    [applyLive],
  );
  useLayoutEffect(() => applyLive());
  useEffect(() => controller.subscribeLive(applyLive), [controller, applyLive]);
  // Resizing a Figma side panel moves the canvas edge: re-clip at once.
  useEffect(() => {
    const refresh = () => {
      canvasRectRef.current.at = 0;
      applyLive();
    };
    const observer = new ResizeObserver(refresh);
    const canvas = findFigmaCanvas();
    if (canvas) observer.observe(canvas);
    window.addEventListener('resize', refresh);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', refresh);
    };
  }, [applyLive, showCanvas]);

  return (
    <>
      {showCanvas ? (
        <div ref={clipRef} className="don-canvas-clip">
          <AnnotationCanvas
            store={controller.store}
            // SVG units are capture CSS px; the viewBox maps them to the live view.
            viewBoxWidth={viewport.width}
            viewBoxHeight={viewport.height}
            viewBox={viewBoxFor(view.transform, viewport.width, viewport.height)}
            svgElementRef={setSvg}
            uiScale={view.transform.s}
            interactive={mode === 'annotate'}
            className="don-live-canvas"
            background={
              ui.reference ? (
                <image
                  href={ui.reference}
                  x={0}
                  y={0}
                  width={capture.viewportCssWidth}
                  height={capture.viewportCssHeight}
                  preserveAspectRatio="none"
                  opacity={0.5}
                  pointerEvents="none"
                  onError={() =>
                    controller.setNotice(
                      {
                        id: 'error',
                        tone: 'error',
                        text: 'The page blocked the reference image. Open the capture in the notes manager instead.',
                        actions: [],
                      },
                      6_000,
                    )
                  }
                />
              ) : null
            }
          />
        </div>
      ) : null}
      {mode === 'annotate' ? <div className="don-mode-frame" aria-hidden="true" /> : null}
      <FloatingArea controller={controller} ui={ui} />
    </>
  );
}

function FloatingArea({ controller, ui }: { controller: OverlayController; ui: OverlayUiState }) {
  const ref = useRef<HTMLDivElement>(null);
  const { mode, notice, toolbarPosition, viewport } = ui;
  if (mode === 'closed' && !notice) return null;

  const clamp = (x: number, y: number) => {
    const rect = ref.current?.getBoundingClientRect();
    const width = rect?.width ?? 300;
    const height = rect?.height ?? 40;
    return {
      x: Math.round(Math.min(Math.max(EDGE_MARGIN, x), viewport.width - width - EDGE_MARGIN)),
      y: Math.round(Math.min(Math.max(EDGE_MARGIN, y), viewport.height - Math.min(height, 48) - EDGE_MARGIN)),
    };
  };

  const position = toolbarPosition ? clamp(toolbarPosition.x, toolbarPosition.y) : null;

  const onGripPointerDown = (e: ReactPointerEvent<HTMLSpanElement>) => {
    const el = ref.current;
    if (!el || e.button !== 0) return;
    e.preventDefault();
    const rect = el.getBoundingClientRect();
    const offsetX = e.clientX - rect.left;
    const offsetY = e.clientY - rect.top;
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    const onMove = (ev: PointerEvent) => controller.setToolbarPosition(clamp(ev.clientX - offsetX, ev.clientY - offsetY), false);
    const onUp = (ev: PointerEvent) => {
      target.removeEventListener('pointermove', onMove);
      target.removeEventListener('pointerup', onUp);
      target.removeEventListener('pointercancel', onUp);
      controller.setToolbarPosition(clamp(ev.clientX - offsetX, ev.clientY - offsetY), true);
    };
    target.addEventListener('pointermove', onMove);
    target.addEventListener('pointerup', onUp);
    target.addEventListener('pointercancel', onUp);
  };

  return (
    <div
      ref={ref}
      className={`don-floating ${position ? 'is-placed' : ''}`}
      style={position ? { left: position.x, top: position.y } : undefined}
    >
      {mode !== 'closed' ? (
        <OverlayToolbar
          controller={controller}
          ui={ui}
          grip={
            <span
              className="don-grip"
              title="Drag to move · double-click to re-center"
              onPointerDown={onGripPointerDown}
              onDoubleClick={() => controller.setToolbarPosition(null, true)}
            >
              <GripVertical size={14} aria-hidden="true" />
            </span>
          }
        />
      ) : null}
      {notice ? <NoticeBanner notice={notice} onDismiss={() => controller.dismissNotice()} /> : null}
    </div>
  );
}

function OverlayToolbar({
  controller,
  ui,
  grip,
}: {
  controller: OverlayController;
  ui: OverlayUiState;
  grip: React.ReactNode;
}) {
  const { mode, capture, busy, saveStatus } = ui;

  if (mode === 'hidden') {
    return (
      <ToolbarShell className="is-compact">
        {grip}
        <button type="button" className="don-text-btn" onClick={() => controller.toggleVisibility()} title={withShortcut('Show notes', ui.shortcuts.toggleVisibility)}>
          <EyeOff size={15} aria-hidden="true" />
          Notes hidden
        </button>
        <ToolButton label="Close overlay" icon={X} onClick={() => controller.close()} />
      </ToolbarShell>
    );
  }

  const title = busy ? 'Capturing…' : (capture?.title ?? 'No capture');
  const viewStatus = ui.view.status;
  const followButton = (
    <ToolButton
      label={
        ui.followView
          ? 'Notes follow Figma scrolling and zoom (click to pin them to the screen)'
          : 'Notes are pinned to the screen (click to make them follow Figma scrolling and zoom)'
      }
      icon={ui.followView ? LocateFixed : LocateOff}
      active={ui.followView}
      disabled={!capture}
      onClick={() => controller.setFollowView(!ui.followView)}
    />
  );
  const statusChip =
    ui.otherPage && viewStatus !== 'off' ? (
      <button
        type="button"
        className="don-status is-link"
        onClick={() => controller.findNotes()}
        title={`These notes are on the page “${ui.otherPage}”: switch to it and go to them`}
      >
        On “{ui.otherPage}” · Go there
      </button>
    ) : viewStatus === 'searching' ? (
      <span className="don-status" role="status">
        Finding notes…
      </span>
    ) : viewStatus === 'lost' ? (
      <button type="button" className="don-status is-warn" onClick={() => controller.findNotes()} title="Find the area of these notes and go there">
        Not in view · Find notes
      </button>
    ) : ui.marksOffscreen ? (
      <button
        type="button"
        className="don-status is-link"
        onClick={() => controller.goToCapturedView()}
        title="Your notes are outside the visible area: scroll and zoom back to them"
      >
        Notes off-screen · Go to them
      </button>
    ) : null;
  const goToViewButton =
    ui.followView && capture ? (
      <ToolButton
        label="Go to the captured view (scroll and zoom Figma back to where this capture was taken)"
        icon={Focus}
        disabled={viewStatus !== 'following'}
        onClick={() => controller.goToCapturedView()}
      />
    ) : null;
  const common = (
    <>
      {followButton}
      {goToViewButton}
      <ToolButton
        label="New capture of the current view"
        icon={Camera}
        shortcut={ui.shortcuts.newCapture || undefined}
        disabled={busy}
        onClick={() => void controller.takeCapture().catch(() => undefined)}
      />
      <ToolButton
        label="Compare with capture (show screenshot faintly)"
        icon={Layers}
        active={ui.reference !== null}
        disabled={!capture}
        onClick={() => void controller.toggleReference()}
      />
      <ToolButton label="Hide notes" icon={Eye} shortcut={ui.shortcuts.toggleVisibility || undefined} onClick={() => controller.toggleVisibility()} />
      <ToolButton label="Open notes manager" icon={PanelRight} onClick={() => controller.openPanel()} />
    </>
  );

  if (mode === 'browse') {
    return (
      <ToolbarShell>
        {grip}
        <span className="don-chip" title={capture ? `Capture: ${capture.title}` : undefined}>
          {title}
        </span>
        {statusChip}
        <button
          type="button"
          className="don-text-btn is-primary"
          onClick={() => controller.setMode('annotate')}
          disabled={!ui.canAnnotate}
          title={
            ui.canAnnotate
              ? withShortcut(capture ? 'Draw over the design' : 'Capture this view and draw over it', ui.shortcuts.activate)
              : 'The area of these notes is not on screen. Go to them first, or take a new capture of this view (camera button).'
          }
        >
          <Pencil size={15} aria-hidden="true" />
          Annotate
        </button>
        <Divider />
        {common}
        <ToolButton label="Close overlay" icon={X} onClick={() => controller.close()} />
        <SaveIndicator status={saveStatus} />
      </ToolbarShell>
    );
  }

  return (
    <ToolbarShell>
      {grip}
      {statusChip}
      <ToolControls store={controller.store} />
      <Divider />
      {common}
      <Divider />
      <button
        type="button"
        className="don-text-btn is-primary"
        onClick={() => controller.setMode('browse')}
        title="Stop drawing and use Figma again (Esc)"
      >
        <Check size={15} aria-hidden="true" />
        Done
      </button>
      <SaveIndicator status={saveStatus} />
    </ToolbarShell>
  );
}

function NoticeBanner({ notice, onDismiss }: { notice: Notice; onDismiss: () => void }) {
  return (
    <div className={`don-banner ${notice.tone === 'error' ? 'is-error' : ''}`} role={notice.tone === 'error' ? 'alert' : 'status'}>
      <span className="don-banner-text">{notice.text}</span>
      {notice.actions.map((action) => (
        <button key={action.label} type="button" className="don-text-btn" onClick={action.run}>
          {action.label}
        </button>
      ))}
      <button type="button" className="don-btn" aria-label="Dismiss" title="Dismiss" onClick={onDismiss}>
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  );
}
