import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Autosaver } from '../../src/editor/autosave';
import { handleEditorKeydown } from '../../src/editor/keyboard';
import { EditorStore } from '../../src/editor/store';
import type { SaveStatus } from '../../src/editor/Toolbar';
import type { Annotation, TextLikeAnnotation } from '../../src/shared/schemas';
import { CAPTURE_ID, rectangle, stroke, text } from './fixtures';

function loaded(annotations: Annotation[] = []) {
  const store = new EditorStore();
  store.load(CAPTURE_ID, annotations);
  return store;
}

describe('EditorStore history', () => {
  it('undoes and redoes additions', () => {
    const store = loaded();
    store.addAnnotation(stroke('a'));
    store.addAnnotation(stroke('b'));
    expect(store.getState().annotations.map((a) => a.id)).toEqual(['a', 'b']);
    store.undo();
    expect(store.getState().annotations.map((a) => a.id)).toEqual(['a']);
    store.redo();
    expect(store.getState().annotations.map((a) => a.id)).toEqual(['a', 'b']);
  });

  it('clears redo after a new change', () => {
    const store = loaded();
    store.addAnnotation(stroke('a'));
    store.undo();
    store.addAnnotation(stroke('b'));
    expect(store.getState().canRedo).toBe(false);
  });

  it('does not undo past a load', () => {
    const store = loaded([stroke('existing')]);
    expect(store.getState().canUndo).toBe(false);
    store.undo();
    expect(store.getState().annotations).toHaveLength(1);
  });

  it('removes many annotations in a single undoable step (eraser)', () => {
    const store = loaded([stroke('a'), stroke('b'), stroke('c')]);
    store.removeAnnotations(['a', 'c']);
    expect(store.getState().annotations.map((a) => a.id)).toEqual(['b']);
    store.undo();
    expect(store.getState().annotations).toHaveLength(3);
  });

  it('bumps the revision on every committed change', () => {
    const store = loaded();
    const start = store.getState().revision;
    store.addAnnotation(stroke('a'));
    store.undo();
    store.redo();
    expect(store.getState().revision).toBe(start + 3);
  });

  it('recolors the selected annotation when the color changes', () => {
    const store = loaded([rectangle('r')]);
    store.select('r');
    store.setColor('#1c7ed6');
    expect(store.getState().annotations[0]?.style.color).toBe('#1c7ed6');
  });
});

describe('text editing', () => {
  const draft = (): TextLikeAnnotation => ({ ...(text('new', '') as TextLikeAnnotation) });

  it('adds a new note only when text was typed', () => {
    const store = loaded();
    store.beginTextEdit(draft(), true);
    store.updateEditingText('Hello');
    store.finishTextEdit();
    expect(store.getState().annotations).toHaveLength(1);

    store.beginTextEdit({ ...draft(), id: 'empty' }, true);
    store.finishTextEdit();
    expect(store.getState().annotations).toHaveLength(1);
  });

  it('deletes an existing note when its text is cleared', () => {
    const store = loaded([text('t', 'Old')]);
    store.beginTextEdit(store.getState().annotations[0] as TextLikeAnnotation, false);
    store.updateEditingText('   ');
    store.finishTextEdit();
    expect(store.getState().annotations).toHaveLength(0);
  });

  it('updates the text of an existing note', () => {
    const store = loaded([text('t', 'Old')]);
    store.beginTextEdit(store.getState().annotations[0] as TextLikeAnnotation, false);
    store.updateEditingText('New');
    store.finishTextEdit();
    const updated = store.getState().annotations[0];
    expect(updated?.type === 'text' && updated.text).toBe('New');
  });
});

describe('keyboard shortcuts', () => {
  const key = (k: string, extra: Partial<KeyboardEventInit> = {}) =>
    ({ key: k, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, isComposing: false, ...extra }) as KeyboardEvent;

  it('switches tools with single keys', () => {
    const store = loaded();
    expect(handleEditorKeydown(key('r'), store)).toBe(true);
    expect(store.getState().tool).toBe('rectangle');
  });

  it('undoes with Ctrl/Cmd+Z and redoes with Shift', () => {
    const store = loaded();
    store.addAnnotation(stroke('a'));
    handleEditorKeydown(key('z', { ctrlKey: true }), store);
    expect(store.getState().annotations).toHaveLength(0);
    handleEditorKeydown(key('Z', { metaKey: true, shiftKey: true }), store);
    expect(store.getState().annotations).toHaveLength(1);
  });

  it('deletes the selection and exits on Escape', () => {
    const store = loaded([stroke('a')]);
    store.select('a');
    handleEditorKeydown(key('Delete'), store);
    expect(store.getState().annotations).toHaveLength(0);
    const onExit = vi.fn();
    handleEditorKeydown(key('Escape'), store, { onExit });
    expect(onExit).toHaveBeenCalled();
  });

  it('leaves keys to the text editor while editing', () => {
    const store = loaded();
    store.beginTextEdit(text('t', '') as TextLikeAnnotation, true);
    expect(handleEditorKeydown(key('r'), store)).toBe(false);
    expect(store.getState().tool).not.toBe('rectangle');
  });
});

describe('Autosaver', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('debounces saves and sends the full annotation set', async () => {
    const store = loaded();
    const save = vi.fn(async (_id: string, _annotations: Annotation[]) => undefined);
    const statuses: SaveStatus['state'][] = [];
    const saver = new Autosaver(store, save, (s) => statuses.push(s.state), 300);
    store.addAnnotation(stroke('a'));
    store.addAnnotation(stroke('b'));
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(300);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]?.[1].map((a) => a.id)).toEqual(['a', 'b']);
    expect(saver.isDirty()).toBe(false);
    expect(statuses.at(-1)).toBe('saved');
  });

  it('flush() saves immediately and is a no-op when clean', async () => {
    const store = loaded();
    const save = vi.fn(async () => undefined);
    const saver = new Autosaver(store, save, () => undefined, 10_000);
    store.addAnnotation(stroke('a'));
    await saver.flush();
    expect(save).toHaveBeenCalledTimes(1);
    await saver.flush();
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('reports errors, stays dirty and retries', async () => {
    const store = loaded();
    let fail = true;
    const save = vi.fn(async () => {
      if (fail) throw new Error('quota exceeded');
    });
    const statuses: SaveStatus[] = [];
    const saver = new Autosaver(store, save, (s) => statuses.push(s), 100);
    store.addAnnotation(stroke('a'));
    await vi.advanceTimersByTimeAsync(100);
    expect(statuses.at(-1)).toEqual({ state: 'error', message: 'quota exceeded' });
    expect(saver.isDirty()).toBe(true);
    fail = false;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(saver.isDirty()).toBe(false);
    expect(statuses.at(-1)?.state).toBe('saved');
  });

  it('saves again when edits happen during a save', async () => {
    const store = loaded();
    let release: () => void = () => undefined;
    const save = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const saver = new Autosaver(store, save, () => undefined, 50);
    store.addAnnotation(stroke('a'));
    await vi.advanceTimersByTimeAsync(50);
    store.addAnnotation(stroke('b')); // while first save is in flight
    release();
    await vi.advanceTimersByTimeAsync(50);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(save).toHaveBeenCalledTimes(2);
    expect(saver.isDirty()).toBe(false);
  });
});
