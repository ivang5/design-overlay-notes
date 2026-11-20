import { useEffect, useMemo, useRef, useState } from 'react';
import { ImageDown, Lock } from 'lucide-react';
import { AnnotationCanvas } from '../editor/AnnotationCanvas';
import { Autosaver } from '../editor/autosave';
import { handleEditorKeydown } from '../editor/keyboard';
import { EditorStore } from '../editor/store';
import { SaveIndicator, ToolbarShell, ToolControls, type SaveStatus } from '../editor/Toolbar';
import { getAnnotations, getCapture, getCaptureImages, getProject, replaceAnnotations } from '../database/repository';
import { getSettings } from '../database/settings';
import { fitCaptureInto } from '../shared/coordinates';
import { createId } from '../shared/ids';
import { broadcastDataChange, errorMessage } from '../shared/messages';
import type { Capture, Project } from '../shared/schemas';
import { useDataChanges } from '../sidepanel/hooks';
import { exportCapturePng, saveCaptureMeta } from '../sidepanel/actions';
import { formatDateTime } from '../sidepanel/components/common';

const STAGE_PADDING = 24;

export function ReviewApp({ captureId }: { captureId: string | null }) {
  const editorId = useMemo(() => createId(), []);
  const store = useMemo(() => new EditorStore({ tool: 'select' }), []);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>({ state: 'idle' });
  const autosaver = useMemo(
    () =>
      new Autosaver(
        store,
        async (id, annotations) => {
          await replaceAnnotations(id, annotations);
          broadcastDataChange({ scope: 'annotations', captureId: id, sourceId: editorId });
        },
        setSaveStatus,
      ),
    [store, editorId],
  );

  const [capture, setCapture] = useState<Capture | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [screenshotUrl, setScreenshotUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deleted, setDeleted] = useState(false);
  const [title, setTitle] = useState('');
  const [exporting, setExporting] = useState(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const [stage, setStage] = useState({ width: 800, height: 600 });

  // Load capture, screenshot and annotations.
  useEffect(() => {
    if (!captureId) {
      setError('No capture specified.');
      return;
    }
    let url: string | null = null;
    let cancelled = false;
    (async () => {
      const [c, images, annotations, settings] = await Promise.all([
        getCapture(captureId),
        getCaptureImages(captureId),
        getAnnotations(captureId),
        getSettings(),
      ]);
      if (cancelled) return;
      if (!c || !images) {
        setError('This capture does not exist (it may have been deleted).');
        return;
      }
      store.setColor(settings.color);
      store.setSize(settings.size);
      store.load(c.id, annotations);
      autosaver.markClean();
      url = URL.createObjectURL(images.screenshot);
      setScreenshotUrl(url);
      setCapture(c);
      setTitle(c.title);
      setProject((await getProject(c.projectId)) ?? null);
    })().catch((e: unknown) => setError(errorMessage(e)));
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [captureId, store, autosaver]);

  useEffect(() => {
    document.title = capture ? `${capture.title} · Design Overlay Notes` : 'Design Overlay Notes';
  }, [capture]);

  // Keep in sync with edits made elsewhere (overlay or another review tab).
  useDataChanges((change) => {
    if (!capture) return;
    if (change.scope === 'all' || (change.scope === 'capture-deleted' && change.captureId === capture.id)) {
      setDeleted(true);
      autosaver.dispose();
      return;
    }
    if (change.captureId !== capture.id) return;
    if (change.scope === 'captures') {
      void getCapture(capture.id).then((c) => {
        if (c) {
          setCapture(c);
          setTitle(c.title);
        }
      });
    } else if (change.scope === 'annotations' && change.sourceId !== editorId) {
      if (autosaver.isDirty() || store.getState().editing) return;
      void getAnnotations(capture.id).then((annotations) => {
        if (autosaver.isDirty()) return;
        store.replaceFromExternal(annotations);
        autosaver.markClean();
      });
    }
  });

  // Fit the capture into the available stage.
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setStage({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [capture]);

  // Keyboard shortcuts and save-on-leave.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const inField = target?.closest('input, textarea') && !target.classList.contains('don-text-editor');
      if (inField) return;
      if (handleEditorKeydown(e, store, { onExit: () => store.setTool('select') })) e.preventDefault();
    };
    const onHide = () => {
      if (document.visibilityState === 'hidden') {
        store.finishTextEdit();
        void autosaver.flush();
      }
    };
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      store.finishTextEdit();
      if (autosaver.isDirty()) {
        void autosaver.flush();
        e.preventDefault();
      }
    };
    window.addEventListener('keydown', onKey);
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
  }, [store, autosaver]);

  if (error || deleted) {
    return (
      <div className="rv-message">
        <p>{deleted ? 'This capture was deleted.' : error}</p>
      </div>
    );
  }
  if (!capture || !screenshotUrl) return <div className="rv-message">Loading…</div>;

  const fit = fitCaptureInto(
    { width: capture.viewportCssWidth, height: capture.viewportCssHeight },
    { width: Math.max(100, stage.width - STAGE_PADDING * 2), height: Math.max(100, stage.height - STAGE_PADDING * 2) },
  );
  // Never upscale beyond the capture's own CSS size (it would only blur).
  const scale = Math.min(1, fit.scale);

  const commitTitle = () => {
    const next = title.trim();
    if (!next) setTitle(capture.title);
    else if (next !== capture.title) void saveCaptureMeta(capture.id, { title: next }).then(setCapture);
  };

  const exportPng = async () => {
    setExporting(true);
    try {
      store.finishTextEdit();
      await autosaver.flush();
      await exportCapturePng(capture);
    } catch (e) {
      setSaveStatus({ state: 'error', message: errorMessage(e) });
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="rv-app">
      <header className="rv-header">
        <div className="rv-titles">
          <input
            className="rv-title"
            value={title}
            aria-label="Capture title"
            onChange={(e) => setTitle(e.target.value)}
            onBlur={commitTitle}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
            }}
          />
          <div className="rv-meta">
            {project ? <span>{project.name}</span> : null}
            <span>{formatDateTime(capture.createdAt)}</span>
            <span>
              {Math.round(capture.viewportCssWidth)}×{Math.round(capture.viewportCssHeight)} @
              {Math.round(capture.devicePixelRatio * 100) / 100}x
            </span>
            {capture.pageUrl ? (
              <a href={capture.pageUrl} target="_blank" rel="noreferrer noopener">
                Open in Figma
              </a>
            ) : null}
          </div>
        </div>
        <button type="button" className="dp-btn is-primary" disabled={exporting} onClick={() => void exportPng()}>
          <ImageDown size={15} aria-hidden="true" /> {exporting ? 'Exporting…' : 'Export PNG'}
        </button>
      </header>

      <div className="don-ui rv-toolbar-row">
        <ToolbarShell>
          <ToolControls store={store} />
          <SaveIndicator status={saveStatus} />
        </ToolbarShell>
      </div>

      <div className="don-ui rv-stage" ref={stageRef}>
        <AnnotationCanvas
          store={store}
          viewBoxWidth={capture.viewportCssWidth}
          viewBoxHeight={capture.viewportCssHeight}
          uiScale={scale}
          interactive
          className="rv-canvas"
          style={{ width: capture.viewportCssWidth * scale, height: capture.viewportCssHeight * scale }}
          background={
            <image
              href={screenshotUrl}
              x={0}
              y={0}
              width={capture.viewportCssWidth}
              height={capture.viewportCssHeight}
              preserveAspectRatio="none"
              pointerEvents="none"
            />
          }
        />
      </div>

      <footer className="rv-footer">
        <Lock size={12} aria-hidden="true" /> Stored only in this browser profile. Edits save automatically.
      </footer>
    </div>
  );
}
