import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import {
  FONT_FAMILY,
  LINE_HEIGHT,
  MAX_STROKE_COORDS,
  STICKY_DEFAULT_WIDTH,
  TEXT_DEFAULT_WIDTH,
} from '../shared/constants';
import type { Point } from '../shared/coordinates';
import { createId } from '../shared/ids';
import type {
  Annotation,
  ArrowAnnotation,
  EllipseAnnotation,
  FreehandAnnotation,
  RectangleAnnotation,
  TextLikeAnnotation,
  Tool,
} from '../shared/schemas';
import { DraftRenderer } from './draft-renderer';
import {
  annotationBounds,
  distance,
  handlePosition,
  hitTest,
  hitTestAnnotation,
  layoutTextAnnotation,
  normalizeRect,
  resizeAnnotation,
  resizeHandlesFor,
  round1,
  tint,
  translateAnnotation,
  type ResizeHandle,
} from './geometry';
import { AnnotationLayer } from './render-react';
import type { EditorStore } from './store';
import { getTextMeasurer, lineHeightFor } from './text-layout';

type ShapeDraft = ArrowAnnotation | RectangleAnnotation | EllipseAnnotation;

type Gesture =
  | { kind: 'freehand'; pointerId: number; draft: FreehandAnnotation; points: number[] }
  | { kind: 'shape'; pointerId: number; draft: ShapeDraft; start: Point }
  | { kind: 'move'; pointerId: number; origin: Annotation; start: Point; current: Annotation | null }
  | {
      kind: 'resize';
      pointerId: number;
      origin: Annotation;
      handle: ResizeHandle;
      start: Point;
      current: Annotation | null;
    }
  | { kind: 'erase'; pointerId: number; erased: Set<string> };

const EMPTY_SET: ReadonlySet<string> = new Set();
const ERASER_BUTTON = 5; // pen eraser end
/** Gap between a selected mark and its dashed outline, in screen px. */
const SELECTION_PAD = 4;
/** Pointer reach of a resize handle, in screen px. */
const HANDLE_REACH = 8;

export interface AnnotationCanvasProps {
  store: EditorStore;
  /** Coordinate space in capture CSS pixels. */
  viewBoxWidth: number;
  viewBoxHeight: number;
  /** Full viewBox override (e.g. a panned/zoomed view of the capture). */
  viewBox?: string;
  /** Receives the <svg> element (e.g. to apply a compositor transform). */
  svgElementRef?: (element: SVGSVGElement | null) => void;
  /** Screen pixels per capture CSS pixel (1 on the live page). Used to size handles. */
  uiScale?: number;
  interactive: boolean;
  className?: string;
  style?: CSSProperties;
  /** Rendered underneath the annotations (e.g. the capture screenshot). */
  background?: ReactNode;
}

export function AnnotationCanvas({
  store,
  viewBoxWidth,
  viewBoxHeight,
  viewBox,
  svgElementRef,
  uiScale = 1,
  interactive,
  className,
  style,
  background,
}: AnnotationCanvasProps) {
  const state = useSyncExternalStore(store.subscribe, store.getState);
  const svgRef = useRef<SVGSVGElement>(null);
  const setSvg = useCallback(
    (element: SVGSVGElement | null) => {
      svgRef.current = element;
      svgElementRef?.(element);
    },
    [svgElementRef],
  );
  const draftRef = useRef<SVGGElement>(null);
  const measure = useMemo(() => getTextMeasurer(), []);
  const draftRenderer = useMemo(() => new DraftRenderer(measure), [measure]);
  const gestureRef = useRef<Gesture | null>(null);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(EMPTY_SET);
  const [gestureActive, setGestureActive] = useState(false);
  const [hoverHandle, setHoverHandle] = useState<ResizeHandle | null>(null);

  useEffect(() => {
    draftRenderer.attach(draftRef.current);
    return () => draftRenderer.attach(null);
  }, [draftRenderer]);

  // Abort any gesture when the surface stops being interactive.
  useEffect(() => {
    if (!interactive && gestureRef.current) endGesture(false);
  });

  const toCanvas = (clientX: number, clientY: number): Point => {
    const ctm = svgRef.current?.getScreenCTM();
    if (!ctm) return { x: clientX, y: clientY };
    const p = new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse());
    return { x: p.x, y: p.y };
  };

  const tolerance = 6 / uiScale;

  function baseFields(tool: Tool) {
    const now = Date.now();
    return {
      id: createId(),
      captureId: store.getState().captureId ?? 'unsaved',
      style: store.styleFor(tool),
      zIndex: 0,
      createdAt: now,
      updatedAt: now,
    };
  }

  function startGesture(gesture: Gesture, target: Element) {
    gestureRef.current = gesture;
    setGestureActive(true);
    try {
      target.setPointerCapture(gesture.pointerId);
    } catch {
      // Pointer already released — the gesture will end on the next event.
    }
  }

  function endGesture(commit: boolean) {
    const gesture = gestureRef.current;
    gestureRef.current = null;
    draftRenderer.render(null);
    setGestureActive(false);
    setHidden(EMPTY_SET);
    if (!gesture || !commit) return;

    switch (gesture.kind) {
      case 'freehand': {
        const points = gesture.points.map(round1);
        store.addAnnotation({ ...gesture.draft, geometry: { points } });
        break;
      }
      case 'shape': {
        // Ignore accidental clicks (thresholds in screen px).
        const d = gesture.draft;
        if (d.type === 'arrow') {
          const g = d.geometry;
          if (Math.hypot(g.x2 - g.x1, g.y2 - g.y1) * uiScale >= 5) store.addAnnotation(d);
        } else if (Math.max(d.geometry.width, d.geometry.height) * uiScale >= 3) {
          store.addAnnotation(d);
        }
        break;
      }
      case 'move':
      case 'resize':
        if (gesture.current) {
          store.updateAnnotation(gesture.current);
          store.select(gesture.current.id);
        }
        break;
      case 'erase':
        store.removeAnnotations([...gesture.erased]);
        break;
    }
  }

  function eraseAt(gesture: Extract<Gesture, { kind: 'erase' }>, p: Point) {
    let changed = false;
    for (const annotation of store.getState().annotations) {
      if (!gesture.erased.has(annotation.id) && hitTestAnnotation(annotation, p, 8 / uiScale, measure)) {
        gesture.erased.add(annotation.id);
        changed = true;
      }
    }
    if (changed) setHidden(new Set(gesture.erased));
  }

  function beginTextAt(tool: 'text' | 'sticky-note', p: Point) {
    const base = baseFields(tool);
    const fontSize = base.style.fontSize ?? 18;
    // Box widths follow the view scale like font sizes (see EditorState.viewScale).
    const viewScale = store.getState().viewScale;
    const draft: TextLikeAnnotation =
      tool === 'text'
        ? {
            ...base,
            type: 'text',
            geometry: {
              x: round1(p.x),
              y: round1(p.y - lineHeightFor(fontSize) / 2),
              width: round1(TEXT_DEFAULT_WIDTH / viewScale),
            },
            text: '',
          }
        : {
            ...base,
            type: 'sticky-note',
            geometry: { x: round1(p.x), y: round1(p.y), width: round1(STICKY_DEFAULT_WIDTH / viewScale) },
            text: '',
          };
    store.beginTextEdit(draft, true);
  }

  function onPointerDown(e: ReactPointerEvent<SVGSVGElement>) {
    if (!interactive) return;
    if (e.button !== 0 && e.button !== ERASER_BUTTON) return;
    if (gestureRef.current) return; // ignore additional pointers (multi-touch)
    e.preventDefault();
    const s = store.getState();
    if (s.editing) {
      // Clicking outside the text editor finishes editing.
      store.finishTextEdit();
      return;
    }
    const p = toCanvas(e.clientX, e.clientY);
    const tool: Tool = e.button === ERASER_BUTTON ? 'eraser' : s.tool;
    const target = e.currentTarget;

    switch (tool) {
      case 'pen':
      case 'highlighter': {
        const points = [p.x, p.y];
        const draft: FreehandAnnotation = {
          ...baseFields(tool),
          type: tool === 'pen' ? 'stroke' : 'highlighter',
          geometry: { points },
        };
        startGesture({ kind: 'freehand', pointerId: e.pointerId, draft, points }, target);
        draftRenderer.render(draft);
        break;
      }
      case 'arrow':
      case 'rectangle':
      case 'ellipse': {
        const base = baseFields(tool);
        const draft: ShapeDraft =
          tool === 'arrow'
            ? { ...base, type: 'arrow', geometry: { x1: p.x, y1: p.y, x2: p.x, y2: p.y } }
            : { ...base, type: tool, geometry: { x: p.x, y: p.y, width: 0, height: 0 } };
        startGesture({ kind: 'shape', pointerId: e.pointerId, draft, start: p }, target);
        break;
      }
      case 'text':
      case 'sticky-note': {
        const hit = hitTest(s.annotations, p, tolerance, measure);
        if (hit && (hit.type === 'text' || hit.type === 'sticky-note')) {
          store.beginTextEdit(hit, false);
        } else {
          beginTextAt(tool, p);
        }
        break;
      }
      case 'eraser': {
        const gesture: Gesture = { kind: 'erase', pointerId: e.pointerId, erased: new Set() };
        startGesture(gesture, target);
        eraseAt(gesture, p);
        break;
      }
      case 'select': {
        const selected = store.getSelected();
        const handle = selected ? handleAt(selected, p) : null;
        if (selected && handle) {
          startGesture({ kind: 'resize', pointerId: e.pointerId, origin: selected, handle, start: p, current: null }, target);
          return;
        }
        const hit = hitTest(s.annotations, p, tolerance, measure);
        store.select(hit?.id ?? null);
        if (hit) {
          startGesture({ kind: 'move', pointerId: e.pointerId, origin: hit, start: p, current: null }, target);
        }
        break;
      }
    }
  }

  /** Resize handle of the selected mark under the pointer, if any. */
  function handleAt(selected: Annotation, p: Point): ResizeHandle | null {
    for (const handle of resizeHandlesFor(selected)) {
      if (distance(handlePosition(selected, handle, measure, SELECTION_PAD / uiScale), p) <= HANDLE_REACH / uiScale) {
        return handle;
      }
    }
    return null;
  }

  function updateHoverHandle(e: ReactPointerEvent<SVGSVGElement>) {
    const s = store.getState();
    const selected = interactive && s.tool === 'select' && !s.editing ? store.getSelected() : null;
    const next = selected ? handleAt(selected, toCanvas(e.clientX, e.clientY)) : null;
    if (next !== hoverHandle) setHoverHandle(next);
  }

  function onPointerMove(e: ReactPointerEvent<SVGSVGElement>) {
    const gesture = gestureRef.current;
    if (!gesture) {
      if (e.pointerType !== 'touch') updateHoverHandle(e);
      return;
    }
    if (e.pointerId !== gesture.pointerId) return;
    const native = e.nativeEvent;
    const p = toCanvas(e.clientX, e.clientY);

    switch (gesture.kind) {
      case 'freehand': {
        const events = typeof native.getCoalescedEvents === 'function' ? native.getCoalescedEvents() : [];
        const samples = events.length > 0 ? events : [native];
        const minStep = 0.75 / uiScale;
        for (const sample of samples) {
          const q = toCanvas(sample.clientX, sample.clientY);
          const n = gesture.points.length;
          const last = { x: gesture.points[n - 2]!, y: gesture.points[n - 1]! };
          // Very long scribbles stop growing instead of becoming unsaveable.
          if (gesture.points.length >= MAX_STROKE_COORDS) break;
          if (distance(last, q) >= minStep) gesture.points.push(q.x, q.y);
        }
        gesture.draft = { ...gesture.draft, geometry: { points: gesture.points } };
        draftRenderer.render(gesture.draft);
        break;
      }
      case 'shape': {
        const { start } = gesture;
        if (gesture.draft.type === 'arrow') {
          let end = p;
          if (e.shiftKey) end = snapAngle(start, p);
          gesture.draft = { ...gesture.draft, geometry: { x1: start.x, y1: start.y, x2: end.x, y2: end.y } };
        } else {
          let { x, y } = p;
          if (e.shiftKey) {
            const size = Math.max(Math.abs(x - start.x), Math.abs(y - start.y));
            x = start.x + Math.sign(x - start.x || 1) * size;
            y = start.y + Math.sign(y - start.y || 1) * size;
          }
          const r = normalizeRect(start.x, start.y, x, y);
          gesture.draft = {
            ...gesture.draft,
            geometry: { x: round1(r.x), y: round1(r.y), width: round1(r.width), height: round1(r.height) },
          };
        }
        draftRenderer.render(gesture.draft);
        break;
      }
      case 'move': {
        const dx = p.x - gesture.start.x;
        const dy = p.y - gesture.start.y;
        if (!gesture.current && Math.hypot(dx, dy) < 2 / uiScale) return;
        if (!gesture.current) setHidden(new Set([gesture.origin.id]));
        gesture.current = translateAnnotation(gesture.origin, dx, dy);
        draftRenderer.render(gesture.current);
        break;
      }
      case 'resize': {
        if (!gesture.current) setHidden(new Set([gesture.origin.id]));
        const isText = gesture.origin.type === 'text' || gesture.origin.type === 'sticky-note';
        gesture.current = resizeAnnotation(gesture.origin, gesture.handle, p.x - gesture.start.x, p.y - gesture.start.y, {
          keepAspect: e.shiftKey,
          minSize: (isText ? 40 : 2) / uiScale,
        });
        draftRenderer.render(gesture.current);
        break;
      }
      case 'erase':
        eraseAt(gesture, p);
        break;
    }
  }

  function onPointerUp(e: ReactPointerEvent<SVGSVGElement>) {
    const gesture = gestureRef.current;
    if (!gesture || e.pointerId !== gesture.pointerId) return;
    endGesture(true);
  }

  function onPointerCancel(e: ReactPointerEvent<SVGSVGElement>) {
    const gesture = gestureRef.current;
    if (!gesture || e.pointerId !== gesture.pointerId) return;
    // The OS/browser took the pointer (e.g. palm rejection): keep freehand
    // ink drawn so far, drop half-finished shape/move/resize gestures.
    endGesture(gesture.kind === 'freehand' || gesture.kind === 'erase');
  }

  function onLostPointerCapture(e: ReactPointerEvent<SVGSVGElement>) {
    const gesture = gestureRef.current;
    if (gesture && e.pointerId === gesture.pointerId) endGesture(true);
  }

  function onDoubleClick(e: React.MouseEvent<SVGSVGElement>) {
    if (!interactive) return;
    const s = store.getState();
    if (s.editing) return;
    const p = toCanvas(e.clientX, e.clientY);
    const hit = hitTest(s.annotations, p, tolerance, measure);
    if (hit && (hit.type === 'text' || hit.type === 'sticky-note')) {
      e.preventDefault();
      store.beginTextEdit(hit, false);
    }
  }

  const editingId = state.editing && !state.editing.isNew ? state.editing.draft.id : null;
  const hiddenWithEditing = useMemo(() => {
    if (!editingId) return hidden;
    const set = new Set(hidden);
    set.add(editingId);
    return set;
  }, [hidden, editingId]);

  const selected = interactive && !gestureActive && !state.editing ? store.getSelected() : null;

  return (
    <svg
      ref={setSvg}
      className={['don-canvas', interactive ? 'is-interactive' : '', className ?? ''].join(' ')}
      data-tool={state.tool}
      data-handle={
        selected && hoverHandle ? (selected.type === 'text' || selected.type === 'sticky-note' ? 'width' : hoverHandle) : undefined
      }
      viewBox={viewBox ?? `0 0 ${viewBoxWidth} ${viewBoxHeight}`}
      preserveAspectRatio="none"
      style={style}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onLostPointerCapture={onLostPointerCapture}
      onMouseDown={(e) => {
        // Keep focus where it is (e.g. in a freshly created text editor).
        if (interactive) e.preventDefault();
      }}
      onDoubleClick={onDoubleClick}
      onContextMenu={(e) => {
        if (interactive) e.preventDefault();
      }}
    >
      {background}
      <AnnotationLayer annotations={state.annotations} hiddenIds={hiddenWithEditing} measure={measure} />
      <g ref={draftRef} className="don-draft" />
      {selected ? <SelectionOverlay annotation={selected} uiScale={uiScale} measure={measure} /> : null}
      {state.editing ? (
        <TextEditor
          key={state.editing.draft.id}
          draft={state.editing.draft}
          onChange={(text) => store.updateEditingText(text)}
          measure={measure}
          uiScale={uiScale}
        />
      ) : null}
    </svg>
  );
}

function snapAngle(start: Point, p: Point): Point {
  const angle = Math.atan2(p.y - start.y, p.x - start.x);
  const step = Math.PI / 12; // 15°
  const snapped = Math.round(angle / step) * step;
  const len = Math.hypot(p.x - start.x, p.y - start.y);
  return { x: start.x + Math.cos(snapped) * len, y: start.y + Math.sin(snapped) * len };
}

function SelectionOverlay({
  annotation,
  uiScale,
  measure,
}: {
  annotation: Annotation;
  uiScale: number;
  measure: ReturnType<typeof getTextMeasurer>;
}) {
  const b = annotationBounds(annotation, measure);
  const pad = SELECTION_PAD / uiScale;
  const handleSize = 9 / uiScale;
  return (
    <g className="don-selection" pointerEvents="none">
      <rect
        x={b.x - pad}
        y={b.y - pad}
        width={b.width + pad * 2}
        height={b.height + pad * 2}
        fill="none"
        stroke="#1c7ed6"
        strokeWidth={1.5 / uiScale}
        strokeDasharray={`${4 / uiScale} ${3 / uiScale}`}
      />
      {resizeHandlesFor(annotation).map((handle) => {
        const p = handlePosition(annotation, handle, measure, pad);
        return (
          <rect
            key={handle}
            x={p.x - handleSize / 2}
            y={p.y - handleSize / 2}
            width={handleSize}
            height={handleSize}
            rx={2 / uiScale}
            fill="#ffffff"
            stroke="#1c7ed6"
            strokeWidth={1.5 / uiScale}
          />
        );
      })}
    </g>
  );
}

function TextEditor({
  draft,
  onChange,
  measure,
  uiScale,
}: {
  draft: TextLikeAnnotation;
  onChange: (text: string) => void;
  measure: ReturnType<typeof getTextMeasurer>;
  uiScale: number;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const layout = layoutTextAnnotation(draft, measure);
  const isSticky = draft.type === 'sticky-note';
  const fontSize = layout.fontSize;
  const width = draft.geometry.width;
  // One spare line so the caret has room before the box grows.
  const height = isSticky
    ? Math.max(layout.box.height, layout.contentHeight + layout.lineHeight + layout.padding * 2)
    : Math.max(layout.lineHeight * 2, layout.contentHeight + layout.lineHeight);

  useEffect(() => {
    // Focus after the pointer sequence that created the editor has finished.
    const id = requestAnimationFrame(() => {
      const el = ref.current;
      if (!el) return;
      el.focus({ preventScroll: true });
      el.setSelectionRange(el.value.length, el.value.length);
    });
    return () => cancelAnimationFrame(id);
  }, []);

  const style: CSSProperties = {
    width: '100%',
    height: '100%',
    boxSizing: 'border-box',
    margin: 0,
    padding: isSticky ? layout.padding : 0,
    border: 'none',
    // Editor chrome is sized in screen px (the foreignObject is scaled with the view).
    outline: `${1.5 / uiScale}px dashed #1c7ed6`,
    borderRadius: 4 / uiScale,
    resize: 'none',
    overflow: 'hidden',
    fontFamily: FONT_FAMILY,
    fontSize,
    fontWeight: isSticky ? 500 : 600,
    lineHeight: LINE_HEIGHT,
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
    color: isSticky ? '#1d1d1f' : draft.style.color,
    background: isSticky ? tint(draft.style.color, 0.78) : 'rgba(255, 255, 255, 0.88)',
  };

  return (
    <foreignObject x={draft.geometry.x} y={draft.geometry.y} width={width} height={height}>
      <textarea
        ref={ref}
        className="don-text-editor"
        value={draft.text}
        placeholder={isSticky ? 'Sticky note…' : 'Type a note…'}
        spellCheck
        style={style}
        onChange={(e) => onChange(e.target.value)}
        onPointerDown={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
      />
    </foreignObject>
  );
}
