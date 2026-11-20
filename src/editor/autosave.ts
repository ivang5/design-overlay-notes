import { AUTOSAVE_DEBOUNCE_MS } from '../shared/constants';
import { errorMessage } from '../shared/messages';
import type { Annotation } from '../shared/schemas';
import type { EditorStore } from './store';
import type { SaveStatus } from './Toolbar';

export type SaveFn = (captureId: string, annotations: Annotation[]) => Promise<void>;

const RETRY_DELAYS_MS = [1_000, 3_000, 8_000];

/**
 * Debounced, serialized autosave of the editor's annotation set.
 *
 * - Saves the full set (idempotent) a short time after the last commit.
 * - Never runs two saves at once; a commit during a save schedules another.
 * - Retries failed saves a few times and reports a visible error status.
 * - `flush()` saves immediately (mode exit, tab hidden, capture switch).
 */
export class Autosaver {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<void> | null = null;
  private savedRevision: number;
  private retryIndex = 0;
  private unsubscribe: () => void;
  private disposed = false;

  constructor(
    private readonly store: EditorStore,
    private readonly save: SaveFn,
    private readonly onStatus: (status: SaveStatus) => void,
    private readonly debounceMs = AUTOSAVE_DEBOUNCE_MS,
  ) {
    this.savedRevision = store.getState().revision;
    this.unsubscribe = store.onCommit(() => this.schedule());
  }

  isDirty(): boolean {
    return this.store.getState().revision !== this.savedRevision;
  }

  /** Treat the current state as persisted (after loading a capture). */
  markClean(): void {
    this.clearTimer();
    this.savedRevision = this.store.getState().revision;
    this.retryIndex = 0;
  }

  schedule(delay = this.debounceMs): void {
    if (this.disposed) return;
    this.clearTimer();
    this.onStatus({ state: 'saving' });
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, delay);
  }

  async flush(): Promise<void> {
    this.clearTimer();
    // Wait for any running save, then save again if there are newer changes.
    while (this.inFlight) await this.inFlight.catch(() => undefined);
    const state = this.store.getState();
    if (!state.captureId || state.revision === this.savedRevision) return;

    const revision = state.revision;
    const captureId = state.captureId;
    const annotations = state.annotations.map((a) => ({ ...a, captureId }) as Annotation);
    this.onStatus({ state: 'saving' });

    this.inFlight = this.save(captureId, annotations)
      .then(() => {
        // Only mark saved if the capture did not change underneath us.
        if (this.store.getState().captureId === captureId) this.savedRevision = Math.max(this.savedRevision, revision);
        this.retryIndex = 0;
        if (this.isDirty()) this.schedule();
        else this.onStatus({ state: 'saved', at: Date.now() });
      })
      .catch((error: unknown) => {
        this.onStatus({ state: 'error', message: errorMessage(error) });
        const delay = RETRY_DELAYS_MS[this.retryIndex];
        if (delay !== undefined && !this.disposed) {
          this.retryIndex++;
          this.timer = setTimeout(() => {
            this.timer = null;
            void this.flush();
          }, delay);
        }
        throw error;
      })
      .finally(() => {
        this.inFlight = null;
      });

    try {
      await this.inFlight;
    } catch {
      // Status already reported; callers of flush() should not crash.
    }
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimer();
    this.unsubscribe();
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
