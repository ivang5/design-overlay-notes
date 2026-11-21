/**
 * Typed message protocol between extension contexts.
 *
 *   content script ──(ContentRequest)──▶ service worker
 *   side panel / review page ──(PageRequest)──▶ service worker
 *   service worker ──(TabCommand)──▶ content script   (chrome.tabs.sendMessage)
 *   any extension context ──(DataChanged)──▶ every other extension page + SW
 *
 * Every message is validated with Zod on receipt. Chrome extension messaging
 * serializes as JSON, so Blobs are never sent through it: extension pages read
 * screenshots directly from IndexedDB instead.
 */
import { z } from 'zod';
import {
  annotationListSchema,
  captureSchema,
  idSchema,
  regionGridSchema,
  settingsPatchSchema,
  viewportMetadataSchema,
  type Annotation,
  type Capture,
  type Settings,
} from './schemas';

export const overlayModeSchema = z.enum(['annotate', 'browse', 'hidden', 'closed']);
export type OverlayMode = z.infer<typeof overlayModeSchema>;

const finite = (limit: number) => z.number().min(-limit).max(limit);

/** live = s · capture + t, in CSS pixels (see shared/view-transform.ts). */
export const viewTransformSchema = z.object({
  s: z.number().min(0.001).max(1_000),
  tx: finite(10_000_000),
  ty: finite(10_000_000),
});

const rectSchema = z.object({
  x: finite(100_000),
  y: finite(100_000),
  width: z.number().min(0).max(100_000),
  height: z.number().min(0).max(100_000),
});

// ---------------------------------------------------------------------------
// Content script → service worker
// ---------------------------------------------------------------------------

export const contentRequestSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('OVERLAY_STATE'),
    captureId: idSchema.nullable(),
    mode: overlayModeSchema,
  }),
  z.object({ type: z.literal('CAPTURE_CREATE'), metadata: viewportMetadataSchema }),
  z.object({ type: z.literal('CAPTURE_LOAD'), captureId: idSchema }),
  z.object({
    type: z.literal('ANNOTATIONS_SAVE'),
    captureId: idSchema,
    editorId: idSchema,
    annotations: annotationListSchema,
  }),
  z.object({ type: z.literal('SCREENSHOT_GET'), captureId: idSchema }),
  z.object({ type: z.literal('SETTINGS_GET') }),
  z.object({ type: z.literal('SETTINGS_SET'), patch: settingsPatchSchema }),
  z.object({ type: z.literal('OPEN_SIDE_PANEL') }),
  z.object({ type: z.literal('OPEN_REVIEW'), captureId: idSchema }),
  z.object({
    type: z.literal('VIEW_ALIGN'),
    captureId: idSchema,
    /** Predicted transform (dead-reckoned from wheel/drag input), if any. */
    seed: viewTransformSchema.nullable(),
    /** Our marks are on screen at `seed`; their pixels must be ignored. */
    inkVisible: z.boolean(),
    /** Figma zoom now ÷ Figma zoom at capture time, if both are known. */
    scaleHint: z.number().min(0.001).max(1_000).nullable(),
    /** Relative uncertainty of scaleHint (0.02 = ±2 %). */
    scaleTolerance: z.number().min(0).max(1).nullable(),
    /** The seed's scale comes from an exact zoom prediction. */
    lockScale: z.boolean(),
    /** Live viewport cells showing the Figma canvas. */
    region: regionGridSchema.nullable(),
    /** Live areas to ignore (our toolbar, banners), CSS px. */
    exclude: z.array(rectSchema).max(32),
    viewport: z.object({ width: z.number().positive().max(100_000), height: z.number().positive().max(100_000) }),
  }),
]);
export type ContentRequest = z.infer<typeof contentRequestSchema>;

/** The user's current global shortcuts (chrome://extensions/shortcuts); '' when unset. */
export interface Shortcuts {
  activate: string;
  newCapture: string;
  toggleVisibility: string;
}

export type ViewAlignResult =
  | { status: 'aligned'; transform: z.infer<typeof viewTransformSchema>; ncc: number; method: 'refine' | 'search' }
  | { status: 'not-found'; ncc: number }
  | { status: 'unavailable'; reason: string };

export interface ContentResponses {
  OVERLAY_STATE: null;
  CAPTURE_CREATE: { capture: Capture };
  CAPTURE_LOAD: {
    capture: Capture;
    annotations: Annotation[];
    /** Where this capture was last found in the requesting tab (a good first guess). */
    lastView?: { s: number; tx: number; ty: number } | null;
  };
  ANNOTATIONS_SAVE: { savedAt: number };
  SCREENSHOT_GET: { dataUrl: string };
  SETTINGS_GET: { settings: Settings; shortcuts: Shortcuts };
  SETTINGS_SET: { settings: Settings };
  OPEN_SIDE_PANEL: null;
  OPEN_REVIEW: null;
  VIEW_ALIGN: ViewAlignResult;
}

// ---------------------------------------------------------------------------
// Side panel / review page → service worker
// ---------------------------------------------------------------------------

export const dataChangeSchema = z.object({
  scope: z.enum(['projects', 'captures', 'capture-deleted', 'annotations', 'all']),
  captureId: idSchema.optional(),
  projectId: idSchema.optional(),
  /** Editor/session id of the writer, so it can ignore its own echo. */
  sourceId: z.string().max(64).optional(),
});
export type DataChange = z.infer<typeof dataChangeSchema>;

export const pageRequestSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('PANEL_GET_ACTIVE_TAB'), windowId: z.number().int() }),
  z.object({ type: z.literal('PANEL_NEW_CAPTURE'), windowId: z.number().int() }),
  z.object({
    type: z.literal('PANEL_SHOW_ON_PAGE'),
    windowId: z.number().int(),
    captureId: idSchema,
    force: z.boolean(),
  }),
  z.object({ type: z.literal('DATA_CHANGED'), change: dataChangeSchema }),
  z.object({ type: z.literal('PANEL_OPEN_IN_FIGMA'), windowId: z.number().int(), captureId: idSchema }),
]);
export type PageRequest = z.infer<typeof pageRequestSchema>;

export type OpenInFigmaResult =
  /** The notes are shown (or will be as soon as the page has loaded). */
  | { status: 'shown' }
  /** Chrome needs a click on the extension icon in that tab first. */
  | { status: 'needs-click' };

export interface ActiveTabInfo {
  tabId: number | null;
  /** null when the extension has no access to the tab (no click on the icon yet). */
  url: string | null;
  supported: boolean;
  projectKey: string | null;
  overlay: { captureId: string | null; mode: OverlayMode } | null;
}

export type ShowOnPageResult =
  | { status: 'shown' }
  | { status: 'mismatch'; reasons: string[] };

export interface PageResponses {
  PANEL_GET_ACTIVE_TAB: ActiveTabInfo;
  PANEL_NEW_CAPTURE: { captureId: string | null };
  PANEL_SHOW_ON_PAGE: ShowOnPageResult;
  DATA_CHANGED: null;
  PANEL_OPEN_IN_FIGMA: OpenInFigmaResult;
}

// ---------------------------------------------------------------------------
// Service worker → content script
// ---------------------------------------------------------------------------

export const tabCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('PING') }),
  z.object({ type: z.literal('CAPTURE_START') }),
  z.object({ type: z.literal('SET_MODE'), mode: overlayModeSchema }),
  z.object({ type: z.literal('TOGGLE_ANNOTATE') }),
  z.object({ type: z.literal('TOGGLE_VISIBILITY') }),
  z.object({ type: z.literal('GET_VIEWPORT') }),
  z.object({
    type: z.literal('SHOW_CAPTURE'),
    captureId: idSchema,
    /** Once found, scroll/zoom Figma back to the captured view ("Open in Figma"). */
    goToView: z.boolean().optional(),
  }),
  z.object({ type: z.literal('CAPTURE_DELETED'), captureId: idSchema.nullable() }),
  z.object({ type: z.literal('CAPTURE_META_CHANGED'), capture: captureSchema }),
  z.object({
    type: z.literal('ANNOTATIONS_CHANGED'),
    captureId: idSchema,
    sourceId: z.string().max(64).optional(),
  }),
  z.object({ type: z.literal('SETTINGS_CHANGED'), followView: z.boolean() }),
]);
export type TabCommand = z.infer<typeof tabCommandSchema>;

export interface OverlayStatus {
  captureId: string | null;
  mode: OverlayMode;
}

export interface LiveViewportInfo {
  width: number;
  height: number;
  devicePixelRatio: number;
  url: string;
}

export interface TabResponses {
  PING: OverlayStatus;
  CAPTURE_START: { captureId: string };
  SET_MODE: OverlayStatus;
  TOGGLE_ANNOTATE: OverlayStatus;
  TOGGLE_VISIBILITY: OverlayStatus;
  GET_VIEWPORT: LiveViewportInfo;
  SHOW_CAPTURE: OverlayStatus;
  CAPTURE_DELETED: null;
  CAPTURE_META_CHANGED: null;
  ANNOTATIONS_CHANGED: null;
  SETTINGS_CHANGED: null;
}

// ---------------------------------------------------------------------------
// Response envelope
// ---------------------------------------------------------------------------

export type Envelope<T> = { ok: true; data: T } | { ok: false; error: string };

export class MessageError extends Error {
  override name = 'MessageError';
}

export function okEnvelope<T>(data: T): Envelope<T> {
  return { ok: true, data };
}

export function errorEnvelope(error: unknown): Envelope<never> {
  return { ok: false, error: errorMessage(error) };
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'Unknown error';
}

export function unwrap<T>(envelope: Envelope<T> | undefined): T {
  if (!envelope) throw new MessageError('No response from the extension background worker');
  if (!envelope.ok) throw new MessageError(envelope.error);
  return envelope.data;
}

/** Send a request from a content script or extension page to the service worker. */
export async function sendToBackground<T extends ContentRequest['type']>(
  message: Extract<ContentRequest, { type: T }>,
): Promise<ContentResponses[T]>;
export async function sendToBackground<T extends PageRequest['type']>(
  message: Extract<PageRequest, { type: T }>,
): Promise<PageResponses[T]>;
export async function sendToBackground(message: ContentRequest | PageRequest): Promise<unknown> {
  const response = (await chrome.runtime.sendMessage(message)) as Envelope<unknown> | undefined;
  return unwrap(response);
}

// chrome.runtime.sendMessage never delivers to the sending page itself, so
// changes are also announced inside the page (e.g. the side panel's own list).
const localChanges = new EventTarget();

export function onLocalDataChange(listener: (change: DataChange) => void): () => void {
  const handler = (event: Event) => listener((event as CustomEvent<DataChange>).detail);
  localChanges.addEventListener('change', handler);
  return () => localChanges.removeEventListener('change', handler);
}

/** Broadcast a data change to this page, the service worker and other extension pages. */
export function broadcastDataChange(change: DataChange): void {
  localChanges.dispatchEvent(new CustomEvent<DataChange>('change', { detail: change }));
  chrome.runtime.sendMessage({ type: 'DATA_CHANGED', change } satisfies PageRequest).catch(() => {
    // No listener awake (e.g. nothing else open) — nothing to notify.
  });
}
