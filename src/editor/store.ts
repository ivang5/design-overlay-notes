/**
 * Framework-agnostic editor state with undo/redo.
 *
 * Annotations are immutable objects; every committed change produces a new
 * array, so history snapshots are cheap (structural sharing). React subscribes
 * through useSyncExternalStore; persistence subscribes through onCommit.
 */
import {
  DEFAULT_COLOR,
  DEFAULT_FONT_SIZE,
  HIGHLIGHTER_OPACITY,
  HIGHLIGHTER_WIDTHS,
  MAX_ANNOTATIONS_PER_CAPTURE,
  MAX_HISTORY,
  STROKE_WIDTHS,
  type SizePreset,
} from '../shared/constants';
import type { Annotation, AnnotationStyle, TextLikeAnnotation, Tool } from '../shared/schemas';

export interface TextEditing {
  /** The annotation being edited, with the live (uncommitted) text. */
  draft: TextLikeAnnotation;
  /** True when the annotation does not exist in `annotations` yet. */
  isNew: boolean;
}

export interface EditorState {
  captureId: string | null;
  annotations: readonly Annotation[];
  selectedId: string | null;
  editing: TextEditing | null;
  tool: Tool;
  color: string;
  /** Stroke size preset for pen, highlighter, arrow and shapes. */
  size: SizePreset;
  /** Font size for text and sticky notes, in screen CSS px. */
  fontSize: number;
  /**
   * Screen pixels per capture pixel of the current view (1 unless the live
   * overlay follows a zoomed Figma canvas). New marks are created at
   * size / viewScale so they look the chosen size on screen.
   */
  viewScale: number;
  canUndo: boolean;
  canRedo: boolean;
  /** Increments on every committed (persist-worthy) change. */
  revision: number;
}

type Listener = () => void;
type CommitListener = (state: EditorState) => void;

export class EditorStore {
  private state: EditorState;
  private past: (readonly Annotation[])[] = [];
  private future: (readonly Annotation[])[] = [];
  private listeners = new Set<Listener>();
  private commitListeners = new Set<CommitListener>();

  constructor(initial?: Partial<Pick<EditorState, 'tool' | 'color' | 'size' | 'fontSize'>>) {
    this.state = {
      captureId: null,
      annotations: [],
      selectedId: null,
      editing: null,
      tool: initial?.tool ?? 'pen',
      color: initial?.color ?? DEFAULT_COLOR,
      size: initial?.size ?? 'm',
      fontSize: initial?.fontSize ?? DEFAULT_FONT_SIZE,
      viewScale: 1,
      canUndo: false,
      canRedo: false,
      revision: 0,
    };
  }

  // -- subscription ---------------------------------------------------------

  getState = (): EditorState => this.state;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Called after every committed change (add/update/delete/undo/redo). */
  onCommit(listener: CommitListener): () => void {
    this.commitListeners.add(listener);
    return () => this.commitListeners.delete(listener);
  }

  private set(patch: Partial<EditorState>): void {
    this.state = {
      ...this.state,
      ...patch,
      canUndo: this.past.length > 0,
      canRedo: this.future.length > 0,
    };
    for (const listener of this.listeners) listener();
  }

  // -- loading --------------------------------------------------------------

  /** Load a capture's annotations, resetting history. Not a commit. */
  load(captureId: string | null, annotations: readonly Annotation[]): void {
    this.past = [];
    this.future = [];
    this.set({ captureId, annotations: [...annotations], selectedId: null, editing: null });
  }

  /** Replace annotations with a newer version saved elsewhere. Clears history. */
  replaceFromExternal(annotations: readonly Annotation[]): void {
    this.load(this.state.captureId, annotations);
  }

  // -- tool & style -----------------------------------------------------------

  setTool(tool: Tool): void {
    this.finishTextEdit();
    this.set({ tool, selectedId: tool === 'select' ? this.state.selectedId : null });
  }

  setColor(color: string): void {
    this.set({ color });
    // Recolor the selected annotation, if any — a common quick fix.
    const selected = this.getSelected();
    if (selected && selected.style.color !== color) {
      this.updateAnnotation({ ...selected, style: { ...selected.style, color } } as Annotation);
    }
    if (this.state.editing) {
      const draft = this.state.editing.draft;
      this.set({ editing: { ...this.state.editing, draft: { ...draft, style: { ...draft.style, color } } } });
    }
  }

  /** Stroke size preset. Also resizes the selected stroke/shape. */
  setSize(size: SizePreset): void {
    this.set({ size });
    const selected = this.getSelected();
    if (selected && !isTextLike(selected)) {
      const width = round2(strokeWidthFor(selected.type === 'highlighter' ? 'highlighter' : 'pen', size) / this.state.viewScale);
      if (selected.style.width !== width) {
        this.updateAnnotation({ ...selected, style: { ...selected.style, width } } as Annotation);
      }
    }
  }

  /** Font size (screen px). Also applies to the text note being edited or selected. */
  setFontSize(fontSize: number): void {
    this.set({ fontSize });
    const scaled = round2(fontSize / this.state.viewScale);
    const editing = this.state.editing;
    if (editing) {
      const draft = editing.draft;
      this.set({ editing: { ...editing, draft: { ...draft, style: { ...draft.style, fontSize: scaled } } } });
      if (!editing.isNew) {
        const existing = this.state.annotations.find((a) => a.id === draft.id);
        if (existing && isTextLike(existing) && existing.style.fontSize !== scaled) {
          this.updateAnnotation({ ...existing, style: { ...existing.style, fontSize: scaled } });
        }
      }
      return;
    }
    const selected = this.getSelected();
    if (selected && isTextLike(selected) && selected.style.fontSize !== scaled) {
      this.updateAnnotation({ ...selected, style: { ...selected.style, fontSize: scaled } });
    }
  }

  setViewScale(viewScale: number): void {
    if (Number.isFinite(viewScale) && viewScale > 0 && viewScale !== this.state.viewScale) this.set({ viewScale });
  }

  /** Style for a new annotation created with the given tool (in capture pixels). */
  styleFor(tool: Tool): AnnotationStyle {
    const { color, size, fontSize, viewScale } = this.state;
    switch (tool) {
      case 'highlighter':
        return { color, width: round2(HIGHLIGHTER_WIDTHS[size] / viewScale), opacity: HIGHLIGHTER_OPACITY };
      case 'text':
      case 'sticky-note':
        return { color, width: 1, opacity: 1, fontSize: round2(fontSize / viewScale) };
      default:
        return { color, width: round2(STROKE_WIDTHS[size] / viewScale), opacity: 1 };
    }
  }

  // -- selection --------------------------------------------------------------

  select(id: string | null): void {
    if (id !== this.state.selectedId) this.set({ selectedId: id });
  }

  getSelected(): Annotation | null {
    const { selectedId, annotations } = this.state;
    return selectedId ? (annotations.find((a) => a.id === selectedId) ?? null) : null;
  }

  // -- committed changes ------------------------------------------------------

  private commit(next: readonly Annotation[], extra: Partial<EditorState> = {}): void {
    this.past.push(this.state.annotations);
    if (this.past.length > MAX_HISTORY) this.past.shift();
    this.future = [];
    this.set({ annotations: next, revision: this.state.revision + 1, ...extra });
    this.emitCommit();
  }

  private emitCommit(): void {
    for (const listener of this.commitListeners) listener(this.state);
  }

  addAnnotation(annotation: Annotation): void {
    if (this.state.annotations.length >= MAX_ANNOTATIONS_PER_CAPTURE) return; // schema limit; see constants
    this.commit([...this.state.annotations, annotation]);
  }

  updateAnnotation(annotation: Annotation): void {
    const index = this.state.annotations.findIndex((a) => a.id === annotation.id);
    if (index === -1) return;
    const next = [...this.state.annotations];
    next[index] = { ...annotation, updatedAt: Date.now() } as Annotation;
    this.commit(next);
  }

  removeAnnotations(ids: readonly string[]): void {
    if (ids.length === 0) return;
    const remove = new Set(ids);
    const next = this.state.annotations.filter((a) => !remove.has(a.id));
    if (next.length === this.state.annotations.length) return;
    const selectedId = this.state.selectedId && remove.has(this.state.selectedId) ? null : this.state.selectedId;
    this.commit(next, { selectedId });
  }

  deleteSelected(): void {
    if (this.state.selectedId) this.removeAnnotations([this.state.selectedId]);
  }

  clearAll(): void {
    if (this.state.annotations.length > 0) this.commit([], { selectedId: null });
  }

  undo(): void {
    this.finishTextEdit();
    const previous = this.past.pop();
    if (!previous) return;
    this.future.push(this.state.annotations);
    this.set({ annotations: previous, selectedId: null, revision: this.state.revision + 1 });
    this.emitCommit();
  }

  redo(): void {
    this.finishTextEdit();
    const next = this.future.pop();
    if (!next) return;
    this.past.push(this.state.annotations);
    this.set({ annotations: next, selectedId: null, revision: this.state.revision + 1 });
    this.emitCommit();
  }

  // -- in-place text editing ----------------------------------------------------

  beginTextEdit(draft: TextLikeAnnotation, isNew: boolean): void {
    if (this.state.editing) this.finishTextEdit();
    this.set({ editing: { draft, isNew }, selectedId: isNew ? null : draft.id });
  }

  updateEditingText(text: string): void {
    const editing = this.state.editing;
    if (!editing) return;
    this.set({ editing: { ...editing, draft: { ...editing.draft, text } } });
  }

  /** Commit the edited text. Empty text deletes the note. */
  finishTextEdit(): void {
    const editing = this.state.editing;
    if (!editing) return;
    const text = editing.draft.text.replace(/\s+$/u, '');
    this.set({ editing: null });
    if (editing.isNew) {
      if (text.trim()) this.addAnnotation({ ...editing.draft, text });
      return;
    }
    const existing = this.state.annotations.find((a) => a.id === editing.draft.id);
    if (!existing) return;
    if (!text.trim()) {
      this.removeAnnotations([existing.id]);
    } else if (
      existing.type === editing.draft.type &&
      (existing.text !== text || !sameStyle(existing.style, editing.draft.style))
    ) {
      this.updateAnnotation({ ...editing.draft, text });
    }
  }

  cancelTextEdit(): void {
    if (this.state.editing) this.set({ editing: null });
  }
}

function isTextLike(annotation: Annotation): annotation is TextLikeAnnotation {
  return annotation.type === 'text' || annotation.type === 'sticky-note';
}

function strokeWidthFor(tool: 'pen' | 'highlighter', size: SizePreset): number {
  return tool === 'highlighter' ? HIGHLIGHTER_WIDTHS[size] : STROKE_WIDTHS[size];
}

function sameStyle(a: AnnotationStyle, b: AnnotationStyle): boolean {
  return a.color === b.color && a.width === b.width && a.opacity === b.opacity && a.fontSize === b.fontSize;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
