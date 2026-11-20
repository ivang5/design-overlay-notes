export const APP_NAME = 'Design Overlay Notes';

/** Tag name of the overlay host element mounted into the Figma page. */
export const OVERLAY_HOST_TAG = 'design-overlay-notes';

export const DB_NAME = 'design-overlay-notes';
export const DB_VERSION = 1;

/** Backup archive identification. Bump BACKUP_FORMAT_VERSION on breaking changes. */
export const BACKUP_FORMAT = 'design-overlay-notes-backup';
export const BACKUP_FORMAT_VERSION = 1;

/** Autosave debounce after the last committed edit (brief: 300–700 ms). */
export const AUTOSAVE_DEBOUNCE_MS = 350;

/** Chrome allows at most 2 captureVisibleTab calls per second. Keep a margin. */
export const MIN_CAPTURE_INTERVAL_MS = 600;

/** Thumbnail width in pixels for the notes manager. */
export const THUMBNAIL_WIDTH = 480;

/** Max undo steps kept in memory per editor session. */
export const MAX_HISTORY = 200;

/** Shared font stack for every text rendering path (live overlay, review, export). */
export const FONT_FAMILY =
  'system-ui, -apple-system, "Segoe UI", Roboto, Ubuntu, Cantarell, "Helvetica Neue", Arial, sans-serif';
export const LINE_HEIGHT = 1.3;

export const PALETTE = [
  '#e5322d', // red
  '#f08c00', // orange
  '#f5c400', // yellow
  '#2f9e44', // green
  '#1c7ed6', // blue
  '#7048e8', // violet
  '#d6336c', // pink
  '#1f1f1f', // near-black
] as const;

export const DEFAULT_COLOR = PALETTE[0];

/** Size presets (S / M / L) shared by all tools. */
export type SizePreset = 's' | 'm' | 'l';
export const STROKE_WIDTHS: Record<SizePreset, number> = { s: 2, m: 4, l: 8 };
export const HIGHLIGHTER_WIDTHS: Record<SizePreset, number> = { s: 12, m: 20, l: 32 };
export const FONT_SIZES: Record<SizePreset, number> = { s: 14, m: 18, l: 26 };
export const HIGHLIGHTER_OPACITY = 0.35;

export const TEXT_DEFAULT_WIDTH = 280;
export const STICKY_DEFAULT_WIDTH = 200;
export const STICKY_PADDING = 10;
export const STICKY_MIN_HEIGHT = 56;

/** Limits shared by the editor (enforced while drawing) and the schemas (enforced on save/import). */
export const MAX_STROKE_COORDS = 40_000; // 20k points per freehand stroke
export const MAX_ANNOTATIONS_PER_CAPTURE = 10_000;

/**
 * Default keyboard shortcuts (chrome.commands suggested keys). Users can change
 * them at chrome://extensions/shortcuts, so UI hints are only defaults.
 *
 * Chrome silently refuses suggested keys that collide with its own
 * accelerators. Verified on Chrome 155 and 158 (Linux): Alt+Shift+N, C, A, X,
 * W, P, R, Z and B are rejected; D, O and S are accepted. They also avoid
 * Figma's Alt+Shift shortcuts (e.g. Alt+Shift+H/V distribute spacing).
 */
export const DEFAULT_SHORTCUTS = {
  activate: 'Alt+Shift+D',
  toggleVisibility: 'Alt+Shift+O',
  newCapture: 'Alt+Shift+S',
} as const;
