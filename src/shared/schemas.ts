/**
 * Runtime schemas (Zod) and the TypeScript types derived from them.
 *
 * These validate every message coming from a content script, every record
 * imported from a backup, and every annotation before it is persisted.
 */
import { z } from 'zod';
import { MAX_ANNOTATIONS_PER_CAPTURE, MAX_STROKE_COORDS } from './constants';

export const idSchema = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/);
const timestamp = z.number().int().nonnegative();
const coord = z.number().min(-1_000_000).max(1_000_000);
const length = z.number().min(0).max(1_000_000);

export const colorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/);

export const annotationStyleSchema = z.object({
  color: colorSchema,
  /**
   * Stroke width in capture CSS pixels. Marks drawn while the view is zoomed
   * in (view tracking) are stored proportionally thinner, hence the low minimum.
   */
  width: z.number().min(0.01).max(1_000),
  opacity: z.number().min(0.05).max(1),
  /** Font size in capture CSS pixels (text and sticky notes only). */
  fontSize: z.number().min(0.1).max(2_000).optional(),
});
export type AnnotationStyle = z.infer<typeof annotationStyleSchema>;

/** Flat [x0, y0, x1, y1, …] list in capture CSS pixels. */
const pointList = z
  .array(coord)
  .min(2)
  .max(MAX_STROKE_COORDS)
  .refine((pts) => pts.length % 2 === 0, 'Point list must contain x/y pairs');

const annotationBase = {
  id: idSchema,
  captureId: idSchema,
  style: annotationStyleSchema,
  zIndex: z.number().int(),
  createdAt: timestamp,
  updatedAt: timestamp,
};

export const strokeAnnotationSchema = z.object({
  ...annotationBase,
  type: z.literal('stroke'),
  geometry: z.object({ points: pointList }),
});

export const highlighterAnnotationSchema = z.object({
  ...annotationBase,
  type: z.literal('highlighter'),
  geometry: z.object({ points: pointList }),
});

export const arrowAnnotationSchema = z.object({
  ...annotationBase,
  type: z.literal('arrow'),
  geometry: z.object({ x1: coord, y1: coord, x2: coord, y2: coord }),
});

const boxGeometry = z.object({ x: coord, y: coord, width: length, height: length });

export const rectangleAnnotationSchema = z.object({
  ...annotationBase,
  type: z.literal('rectangle'),
  geometry: boxGeometry,
});

export const ellipseAnnotationSchema = z.object({
  ...annotationBase,
  type: z.literal('ellipse'),
  geometry: boxGeometry,
});

/** Text boxes are anchored at their top-left corner and wrap at `width`. */
const textGeometry = z.object({ x: coord, y: coord, width: z.number().min(0.5).max(100_000) });

export const textAnnotationSchema = z.object({
  ...annotationBase,
  type: z.literal('text'),
  geometry: textGeometry,
  text: z.string().max(10_000),
});

export const stickyNoteAnnotationSchema = z.object({
  ...annotationBase,
  type: z.literal('sticky-note'),
  geometry: textGeometry,
  text: z.string().max(10_000),
});

export const annotationSchema = z.discriminatedUnion('type', [
  strokeAnnotationSchema,
  highlighterAnnotationSchema,
  arrowAnnotationSchema,
  rectangleAnnotationSchema,
  ellipseAnnotationSchema,
  textAnnotationSchema,
  stickyNoteAnnotationSchema,
]);

export type Annotation = z.infer<typeof annotationSchema>;
export type AnnotationType = Annotation['type'];
export type StrokeAnnotation = z.infer<typeof strokeAnnotationSchema>;
export type HighlighterAnnotation = z.infer<typeof highlighterAnnotationSchema>;
export type ArrowAnnotation = z.infer<typeof arrowAnnotationSchema>;
export type RectangleAnnotation = z.infer<typeof rectangleAnnotationSchema>;
export type EllipseAnnotation = z.infer<typeof ellipseAnnotationSchema>;
export type TextAnnotation = z.infer<typeof textAnnotationSchema>;
export type StickyNoteAnnotation = z.infer<typeof stickyNoteAnnotationSchema>;
export type TextLikeAnnotation = TextAnnotation | StickyNoteAnnotation;
export type FreehandAnnotation = StrokeAnnotation | HighlighterAnnotation;
export type BoxAnnotation = RectangleAnnotation | EllipseAnnotation;

export const ANNOTATION_TYPES: readonly AnnotationType[] = [
  'stroke',
  'highlighter',
  'arrow',
  'rectangle',
  'ellipse',
  'text',
  'sticky-note',
];

export const annotationListSchema = z.array(annotationSchema).max(MAX_ANNOTATIONS_PER_CAPTURE);

// ---------------------------------------------------------------------------
// Projects and captures
// ---------------------------------------------------------------------------

export const projectSchema = z.object({
  id: idSchema,
  name: z.string().min(1).max(300),
  platform: z.literal('figma'),
  /** Local grouping key parsed from the Figma URL (file key, or key/branch/branchKey). */
  fileKey: z.string().max(200).nullable(),
  createdAt: timestamp,
  updatedAt: timestamp,
});
export type Project = z.infer<typeof projectSchema>;

/** Which viewport cells show the Figma canvas (see shared/region-grid.ts). */
export const regionGridSchema = z.object({
  cell: z.number().min(4).max(256),
  cols: z.number().int().min(1).max(2_000),
  rows: z.number().int().min(1).max(2_000),
  bits: z.string().max(700_000),
});

/**
 * Optional view-tracking data. Absent on captures made before view tracking
 * existed; those can still be aligned, just less robustly.
 */
const viewTrackingFields = {
  /** Figma's zoom level when captured (1 = 100%), read from Figma's zoom menu label. */
  figmaZoom: z.number().positive().max(1_000).nullable().optional(),
  /** Viewport cells that showed the Figma canvas when captured. */
  regionGrid: regionGridSchema.nullable().optional(),
  /** Name of the Figma page that was open (to return to it). */
  figmaPage: z.string().max(500).nullable().optional(),
};

/** Viewport metadata measured by the content script right before a capture. */
export const viewportMetadataSchema = z.object({
  ...viewTrackingFields,
  pageUrl: z.string().max(4_000),
  pageTitle: z.string().max(1_000).nullable(),
  viewportCssWidth: z.number().positive().max(100_000),
  viewportCssHeight: z.number().positive().max(100_000),
  devicePixelRatio: z.number().positive().max(16),
  scrollX: z.number(),
  scrollY: z.number(),
  visualViewportScale: z.number().nullable(),
  visualViewportOffsetLeft: z.number().nullable(),
  visualViewportOffsetTop: z.number().nullable(),
});
export type ViewportMetadata = z.infer<typeof viewportMetadataSchema>;

export const captureSchema = z.object({
  id: idSchema,
  projectId: idSchema,
  title: z.string().max(300),
  description: z.string().max(20_000),
  tags: z.array(z.string().min(1).max(60)).max(50),
  /** Sanitized URL (allowlisted query parameters only). */
  pageUrl: z.string().max(4_000),
  pageTitle: z.string().max(1_000).nullable(),
  screenshotMimeType: z.string().max(100),
  screenshotPixelWidth: z.number().int().positive(),
  screenshotPixelHeight: z.number().int().positive(),
  viewportCssWidth: z.number().positive(),
  viewportCssHeight: z.number().positive(),
  devicePixelRatio: z.number().positive(),
  scrollX: z.number(),
  scrollY: z.number(),
  visualViewportScale: z.number().nullable(),
  visualViewportOffsetLeft: z.number().nullable(),
  visualViewportOffsetTop: z.number().nullable(),
  ...viewTrackingFields,
  /** Denormalized for fast listing/search; recomputed on every annotation save. */
  annotationCount: z.number().int().nonnegative(),
  searchText: z.string().max(200_000),
  createdAt: timestamp,
  updatedAt: timestamp,
});
export type Capture = z.infer<typeof captureSchema>;

/** Screenshot blobs live in their own object store, keyed by capture id. */
export interface CaptureImages {
  captureId: string;
  screenshot: Blob;
  thumbnail: Blob | null;
}

export const LABEL_SUGGESTIONS = [
  'Question',
  'Implementation',
  'Bug',
  'Design decision',
  'Idea',
] as const;

// ---------------------------------------------------------------------------
// Settings (chrome.storage.local — small preferences only, never sync)
// ---------------------------------------------------------------------------

export const toolSchema = z.enum([
  'select',
  'pen',
  'highlighter',
  'arrow',
  'rectangle',
  'ellipse',
  'text',
  'sticky-note',
  'eraser',
]);
export type Tool = z.infer<typeof toolSchema>;

export const settingsSchema = z.object({
  tool: toolSchema,
  color: colorSchema,
  size: z.enum(['s', 'm', 'l']),
  /** Font size for new text and sticky notes (CSS px at 100% view scale). */
  fontSize: z.number().min(6).max(200),
  /** Keep marks attached to the design when the Figma canvas is panned/zoomed. */
  followView: z.boolean(),
  toolbarPosition: z.object({ x: z.number(), y: z.number() }).nullable(),
});
export type Settings = z.infer<typeof settingsSchema>;
export const settingsPatchSchema = settingsSchema.partial();
export type SettingsPatch = z.infer<typeof settingsPatchSchema>;
