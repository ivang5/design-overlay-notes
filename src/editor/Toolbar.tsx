import { useState, useSyncExternalStore, type ReactNode } from 'react';
import {
  Circle,
  Eraser,
  Highlighter,
  MousePointer2,
  MoveUpRight,
  PenLine,
  Redo2,
  Square,
  StickyNote,
  Trash2,
  Type,
  Undo2,
  type LucideIcon,
} from 'lucide-react';
import { PALETTE, TEXT_FONT_SIZES, type SizePreset } from '../shared/constants';
import type { Annotation, Tool } from '../shared/schemas';
import { TOOL_SHORTCUTS } from './keyboard';
import type { EditorState, EditorStore } from './store';

export type SaveStatus =
  | { state: 'idle' }
  | { state: 'saving' }
  | { state: 'saved'; at: number }
  | { state: 'error'; message: string };

const TOOLS: { tool: Tool; label: string; icon: LucideIcon }[] = [
  { tool: 'select', label: 'Select / move', icon: MousePointer2 },
  { tool: 'pen', label: 'Pen', icon: PenLine },
  { tool: 'highlighter', label: 'Highlighter', icon: Highlighter },
  { tool: 'arrow', label: 'Arrow', icon: MoveUpRight },
  { tool: 'rectangle', label: 'Rectangle', icon: Square },
  { tool: 'ellipse', label: 'Ellipse', icon: Circle },
  { tool: 'text', label: 'Text note', icon: Type },
  { tool: 'sticky-note', label: 'Sticky note', icon: StickyNote },
  { tool: 'eraser', label: 'Eraser', icon: Eraser },
];

const SIZES: { size: SizePreset; label: string; dot: number }[] = [
  { size: 's', label: 'Small', dot: 4 },
  { size: 'm', label: 'Medium', dot: 7 },
  { size: 'l', label: 'Large', dot: 11 },
];

export function ToolButton({
  label,
  icon: Icon,
  active,
  disabled,
  onClick,
  shortcut,
  variant,
}: {
  label: string;
  icon: LucideIcon;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  shortcut?: string;
  variant?: 'danger' | 'primary';
}) {
  const title = shortcut ? `${label} (${shortcut})` : label;
  return (
    <button
      type="button"
      className={['don-btn', active ? 'is-active' : '', variant ? `is-${variant}` : ''].join(' ')}
      aria-label={label}
      aria-pressed={active}
      title={title}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon size={17} strokeWidth={2} aria-hidden="true" />
    </button>
  );
}

export function Divider() {
  return <span className="don-divider" aria-hidden="true" />;
}

export function SaveIndicator({ status }: { status: SaveStatus }) {
  let text = '';
  let tone = 'muted';
  switch (status.state) {
    case 'idle':
      return null;
    case 'saving':
      text = 'Saving…';
      break;
    case 'saved':
      text = 'Saved';
      tone = 'ok';
      break;
    case 'error':
      text = 'Save failed';
      tone = 'error';
      break;
  }
  return (
    <span
      className={`don-save is-${tone}`}
      role="status"
      title={status.state === 'error' ? status.message : 'Notes are stored only in this browser profile'}
    >
      {text}
    </span>
  );
}

type StyleTarget = 'text' | 'stroke' | 'none';

/** Which size control applies: the mark being edited/selected wins over the active tool. */
function styleTargetOf(state: EditorState, selected: Annotation | null): StyleTarget {
  const type = state.editing?.draft.type ?? selected?.type ?? null;
  if (type) return type === 'text' || type === 'sticky-note' ? 'text' : 'stroke';
  if (state.tool === 'text' || state.tool === 'sticky-note') return 'text';
  if (state.tool === 'eraser' || state.tool === 'select') return 'none';
  return 'stroke';
}

/** Font size shown in the picker: the edited/selected note's size on screen, else the tool default. */
function displayedFontSize(state: EditorState, selected: Annotation | null): number {
  const note = state.editing?.draft ?? (selected && (selected.type === 'text' || selected.type === 'sticky-note') ? selected : null);
  if (note?.style.fontSize) return Math.round(note.style.fontSize * state.viewScale);
  return state.fontSize;
}

/** Drawing tools, style controls and undo/redo. */
export function ToolControls({ store }: { store: EditorStore }) {
  const state = useSyncExternalStore(store.subscribe, store.getState);
  const [open, setOpen] = useState<'color' | 'font' | null>(null);
  const paletteOpen = open === 'color';
  const selected = state.selectedId ? (state.annotations.find((a) => a.id === state.selectedId) ?? null) : null;
  const target = styleTargetOf(state, selected);
  const fontSize = displayedFontSize(state, selected);

  return (
    <>
      <div className="don-group" role="group" aria-label="Tools">
        {TOOLS.map(({ tool, label, icon }) => (
          <ToolButton
            key={tool}
            label={label}
            icon={icon}
            shortcut={TOOL_SHORTCUTS[tool]}
            active={state.tool === tool}
            onClick={() => store.setTool(tool)}
          />
        ))}
      </div>
      <Divider />
      <div className="don-group don-style" role="group" aria-label="Style">
        <div className="don-popover-anchor">
          <button
            type="button"
            className="don-btn don-color-btn"
            aria-label="Color"
            title="Color"
            aria-expanded={paletteOpen}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setOpen((current) => (current === 'color' ? null : 'color'))}
          >
            <span className="don-swatch" style={{ background: state.color }} />
          </button>
          {paletteOpen ? (
            <div className="don-popover" role="listbox" aria-label="Colors">
              {PALETTE.map((color) => (
                <button
                  key={color}
                  type="button"
                  role="option"
                  aria-selected={state.color === color}
                  className={`don-swatch-btn ${state.color === color ? 'is-active' : ''}`}
                  title={color}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    store.setColor(color);
                    setOpen(null);
                  }}
                >
                  <span className="don-swatch" style={{ background: color }} />
                </button>
              ))}
            </div>
          ) : null}
        </div>
        {/* Fixed-width slot so the toolbar does not shift when switching tools. */}
        <span className="don-size-slot">
          {target === 'text' ? (
            <div className="don-popover-anchor">
              <button
                type="button"
                className="don-btn don-font-btn"
                aria-label={`Font size ${fontSize}`}
                title="Font size"
                aria-expanded={open === 'font'}
                onClick={() => setOpen((current) => (current === 'font' ? null : 'font'))}
                // Keep focus (and the caret) in the note being edited.
                onMouseDown={(e) => e.preventDefault()}
              >
                <Type size={13} aria-hidden="true" />
                <span>{fontSize}</span>
              </button>
              {open === 'font' ? (
                <div className="don-popover don-font-list" role="listbox" aria-label="Font sizes">
                  {TEXT_FONT_SIZES.map((size) => (
                    <button
                      key={size}
                      type="button"
                      role="option"
                      aria-selected={fontSize === size}
                      className={`don-font-option ${fontSize === size ? 'is-active' : ''}`}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => {
                        store.setFontSize(size);
                        setOpen(null);
                      }}
                    >
                      {size}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          ) : (
            // Dimmed (not hidden) when nothing they apply to is selected, so the toolbar keeps its layout.
            SIZES.map(({ size, label, dot }) => (
              <button
                key={size}
                type="button"
                className={`don-btn don-size-btn ${state.size === size && target === 'stroke' ? 'is-active' : ''}`}
                aria-label={`${label} stroke`}
                aria-pressed={state.size === size}
                title={`${label} stroke`}
                disabled={target === 'none'}
                onClick={() => store.setSize(size)}
              >
                <span className="don-size-dot" style={{ width: dot, height: dot }} />
              </button>
            ))
          )}
        </span>
      </div>
      <Divider />
      <div className="don-group" role="group" aria-label="History">
        <ToolButton label="Undo" icon={Undo2} shortcut="Ctrl/⌘+Z" disabled={!state.canUndo} onClick={() => store.undo()} />
        <ToolButton
          label="Redo"
          icon={Redo2}
          shortcut="Ctrl/⌘+Shift+Z"
          disabled={!state.canRedo}
          onClick={() => store.redo()}
        />
        <ToolButton
          label="Delete selected"
          icon={Trash2}
          shortcut="Delete"
          disabled={!state.selectedId}
          onClick={() => store.deleteSelected()}
        />
      </div>
    </>
  );
}

export function ToolbarShell({
  children,
  className,
  style,
  onPointerDownCapture,
}: {
  children: ReactNode;
  className?: string;
  style?: React.CSSProperties;
  onPointerDownCapture?: (e: React.PointerEvent<HTMLDivElement>) => void;
}) {
  return (
    <div
      className={`don-toolbar ${className ?? ''}`}
      role="toolbar"
      aria-label="Design Overlay Notes"
      style={style}
      onPointerDownCapture={onPointerDownCapture}
    >
      {children}
    </div>
  );
}
