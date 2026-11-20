import { useRef, useSyncExternalStore, type PointerEvent as ReactPointerEvent } from 'react';
import { Camera, Check, Eye, EyeOff, GripVertical, Layers, PanelRight, Pencil, X } from 'lucide-react';
import { AnnotationCanvas } from '../editor/AnnotationCanvas';
import { DEFAULT_SHORTCUTS } from '../shared/constants';
import { Divider, SaveIndicator, ToolButton, ToolbarShell, ToolControls } from '../editor/Toolbar';
import type { Notice, OverlayController, OverlayUiState } from './controller';

const EDGE_MARGIN = 8;

export function OverlayApp({ controller }: { controller: OverlayController }) {
  const ui = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const { mode, capture, viewport } = ui;
  const showCanvas = capture !== null && (mode === 'browse' || mode === 'annotate');

  return (
    <>
      {showCanvas ? (
        <AnnotationCanvas
          store={controller.store}
          // 1 SVG unit = 1 CSS pixel of the live viewport (identity transform).
          viewBoxWidth={viewport.width}
          viewBoxHeight={viewport.height}
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
        <button type="button" className="don-text-btn" onClick={() => controller.toggleVisibility()} title={`Show notes (${DEFAULT_SHORTCUTS.toggleVisibility})`}>
          <EyeOff size={15} aria-hidden="true" />
          Notes hidden
        </button>
        <ToolButton label="Close overlay" icon={X} onClick={() => controller.close()} />
      </ToolbarShell>
    );
  }

  const title = busy ? 'Capturing…' : (capture?.title ?? 'No capture');
  const common = (
    <>
      <ToolButton
        label="New capture of the current view"
        icon={Camera}
        shortcut={DEFAULT_SHORTCUTS.newCapture}
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
      <ToolButton label="Hide notes" icon={Eye} shortcut={DEFAULT_SHORTCUTS.toggleVisibility} onClick={() => controller.toggleVisibility()} />
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
        <button
          type="button"
          className="don-text-btn is-primary"
          onClick={() => controller.setMode('annotate')}
          title={`Draw over the design (${DEFAULT_SHORTCUTS.activate})`}
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
