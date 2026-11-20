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
  settingsPatchSchema,
  viewportMetadataSchema,
  type Annotation,
  type Capture,
  type Settings,
} from './schemas';

export const overlayModeSchema = z.enum(['annotate', 'browse', 'hidden', 'closed']);
export type OverlayMode = z.infer<typeof overlayModeSchema>;

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
]);
export type ContentRequest = z.infer<typeof contentRequestSchema>;

export interface ContentResponses {
  OVERLAY_STATE: null;
  CAPTURE_CREATE: { capture: Capture };
  CAPTURE_LOAD: { capture: Capture; annotations: Annotation[] };
  ANNOTATIONS_SAVE: { savedAt: number };
  SCREENSHOT_GET: { dataUrl: string };
  SETTINGS_GET: { settings: Settings };
  SETTINGS_SET: { settings: Settings };
  OPEN_SIDE_PANEL: null;
  OPEN_REVIEW: null;
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
]);
export type PageRequest = z.infer<typeof pageRequestSchema>;

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
  z.object({ type: z.literal('SHOW_CAPTURE'), captureId: idSchema }),
  z.object({ type: z.literal('CAPTURE_DELETED'), captureId: idSchema.nullable() }),
  z.object({ type: z.literal('CAPTURE_META_CHANGED'), capture: captureSchema }),
  z.object({
    type: z.literal('ANNOTATIONS_CHANGED'),
    captureId: idSchema,
    sourceId: z.string().max(64).optional(),
  }),
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

/** Broadcast a data change to the service worker and other extension pages. */
export function broadcastDataChange(change: DataChange): void {
  chrome.runtime.sendMessage({ type: 'DATA_CHANGED', change } satisfies PageRequest).catch(() => {
    // No listener awake (e.g. nothing else open) — nothing to notify.
  });
}
