import type { Tool } from '../shared/schemas';
import type { EditorStore } from './store';

const TOOL_KEYS: Record<string, Tool> = {
  v: 'select',
  p: 'pen',
  h: 'highlighter',
  a: 'arrow',
  r: 'rectangle',
  o: 'ellipse',
  t: 'text',
  s: 'sticky-note',
  e: 'eraser',
};

export const TOOL_SHORTCUTS: Record<Tool, string> = {
  select: 'V',
  pen: 'P',
  highlighter: 'H',
  arrow: 'A',
  rectangle: 'R',
  ellipse: 'O',
  text: 'T',
  'sticky-note': 'S',
  eraser: 'E',
};

export interface KeyHandlerOptions {
  /** Called on Escape when nothing is selected or being edited. */
  onExit?: () => void;
}

/**
 * Editor keyboard shortcuts. Returns true when the key was handled (the
 * caller should then preventDefault).
 */
export function handleEditorKeydown(e: KeyboardEvent, store: EditorStore, options: KeyHandlerOptions = {}): boolean {
  if (e.isComposing) return false;
  const state = store.getState();
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key;

  if (state.editing) {
    if (key === 'Escape' || (mod && key === 'Enter')) {
      store.finishTextEdit();
      return true;
    }
    return false; // let the textarea receive the key
  }

  if (mod && !e.altKey) {
    const lower = key.toLowerCase();
    if (lower === 'z' && !e.shiftKey) {
      store.undo();
      return true;
    }
    if ((lower === 'z' && e.shiftKey) || lower === 'y') {
      store.redo();
      return true;
    }
    return false;
  }

  if (e.altKey) return false;

  if (key === 'Escape') {
    if (state.selectedId) store.select(null);
    else options.onExit?.();
    return true;
  }
  if (key === 'Delete' || key === 'Backspace') {
    if (state.selectedId) {
      store.deleteSelected();
      return true;
    }
    return false;
  }
  if (key === 'Enter' && state.selectedId) {
    const selected = store.getSelected();
    if (selected && (selected.type === 'text' || selected.type === 'sticky-note')) {
      store.beginTextEdit(selected, false);
      return true;
    }
  }
  const tool = e.shiftKey ? undefined : TOOL_KEYS[key.toLowerCase()];
  if (tool) {
    store.setTool(tool);
    return true;
  }
  return false;
}
