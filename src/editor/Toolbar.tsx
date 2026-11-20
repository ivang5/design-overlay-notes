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
import { PALETTE, type SizePreset } from '../shared/constants';
import type { Tool } from '../shared/schemas';
import { TOOL_SHORTCUTS } from './keyboard';
import type { EditorStore } from './store';

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

/** Drawing tools, style controls and undo/redo. */
export function ToolControls({ store }: { store: EditorStore }) {
  const state = useSyncExternalStore(store.subscribe, store.getState);
  const [paletteOpen, setPaletteOpen] = useState(false);

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
            onClick={() => setPaletteOpen((open) => !open)}
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
                  onClick={() => {
                    store.setColor(color);
                    setPaletteOpen(false);
                  }}
                >
                  <span className="don-swatch" style={{ background: color }} />
                </button>
              ))}
            </div>
          ) : null}
        </div>
        {SIZES.map(({ size, label, dot }) => (
          <button
            key={size}
            type="button"
            className={`don-btn don-size-btn ${state.size === size ? 'is-active' : ''}`}
            aria-label={`${label} size`}
            aria-pressed={state.size === size}
            title={`${label} stroke / text`}
            onClick={() => store.setSize(size)}
          >
            <span className="don-size-dot" style={{ width: dot, height: dot }} />
          </button>
        ))}
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
