/**
 * Repository layer: the only place that knows how records are stored.
 * Used by the service worker (on behalf of content scripts) and directly by
 * extension pages (side panel, review page).
 */
import type { IDBPTransaction } from 'idb';
import { getDb, type OverlayNotesDB } from './db';
import { createId } from '../shared/ids';
import { cleanFigmaTitle } from '../shared/figma-url';
import type {
  Annotation,
  Capture,
  CaptureImages,
  Project,
  ViewportMetadata,
} from '../shared/schemas';

export class NotFoundError extends Error {
  override name = 'NotFoundError';
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export async function listProjects(): Promise<Project[]> {
  const db = await getDb();
  const projects = await db.getAll('projects');
  return projects.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getProject(id: string): Promise<Project | undefined> {
  const db = await getDb();
  return db.get('projects', id);
}

/**
 * Find the local project for a Figma file key, or create it. Captures without
 * a recognizable file key are grouped under a single "Unsorted" project.
 */
export async function ensureProject(projectKey: string | null, name: string): Promise<Project> {
  const db = await getDb();
  const tx = db.transaction('projects', 'readwrite');
  const existing = await tx.store.index('byFileKey').get(projectKey ?? '__unsorted__');
  if (existing) {
    await tx.done;
    return existing;
  }
  const now = Date.now();
  const project: Project = {
    id: createId(),
    name: projectKey ? name : 'Unsorted',
    platform: 'figma',
    fileKey: projectKey ?? '__unsorted__',
    createdAt: now,
    updatedAt: now,
  };
  await tx.store.put(project);
  await tx.done;
  return project;
}

export async function renameProject(id: string, name: string): Promise<Project> {
  const db = await getDb();
  const tx = db.transaction('projects', 'readwrite');
  const project = await tx.store.get(id);
  if (!project) throw new NotFoundError('Project not found');
  const updated: Project = { ...project, name: name.trim().slice(0, 300) || project.name, updatedAt: Date.now() };
  await tx.store.put(updated);
  await tx.done;
  return updated;
}

/** Delete a project with all its captures, screenshots and annotations. */
export async function deleteProject(id: string): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(['projects', 'captures', 'captureImages', 'annotations'], 'readwrite');
  const captureIds = await tx.objectStore('captures').index('byProjectId').getAllKeys(id);
  for (const captureId of captureIds) {
    await deleteCaptureInTx(tx, captureId);
  }
  await tx.objectStore('projects').delete(id);
  await tx.done;
}

// ---------------------------------------------------------------------------
// Captures
// ---------------------------------------------------------------------------

export async function listCaptures(): Promise<Capture[]> {
  const db = await getDb();
  const captures = await db.getAll('captures');
  return captures.sort((a, b) => b.createdAt - a.createdAt);
}

export async function getCapture(id: string): Promise<Capture | undefined> {
  const db = await getDb();
  return db.get('captures', id);
}

export async function getCaptureImages(id: string): Promise<CaptureImages | undefined> {
  const db = await getDb();
  return db.get('captureImages', id);
}

export interface NewCaptureInput {
  metadata: ViewportMetadata;
  /** Sanitized page URL. */
  pageUrl: string;
  projectKey: string | null;
  projectName: string;
  screenshot: Blob;
  thumbnail: Blob | null;
  screenshotPixelWidth: number;
  screenshotPixelHeight: number;
  now?: number;
}

export function defaultCaptureTitle(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(timestamp),
  );
}

export async function createCapture(input: NewCaptureInput): Promise<Capture> {
  const project = await ensureProject(input.projectKey, input.projectName);
  const now = input.now ?? Date.now();
  const m = input.metadata;
  const capture: Capture = {
    id: createId(),
    projectId: project.id,
    title: defaultCaptureTitle(now),
    description: '',
    tags: [],
    pageUrl: input.pageUrl,
    pageTitle: cleanFigmaTitle(m.pageTitle) ?? m.pageTitle,
    screenshotMimeType: input.screenshot.type || 'image/png',
    screenshotPixelWidth: input.screenshotPixelWidth,
    screenshotPixelHeight: input.screenshotPixelHeight,
    viewportCssWidth: m.viewportCssWidth,
    viewportCssHeight: m.viewportCssHeight,
    devicePixelRatio: m.devicePixelRatio,
    scrollX: m.scrollX,
    scrollY: m.scrollY,
    visualViewportScale: m.visualViewportScale,
    visualViewportOffsetLeft: m.visualViewportOffsetLeft,
    visualViewportOffsetTop: m.visualViewportOffsetTop,
    annotationCount: 0,
    searchText: '',
    createdAt: now,
    updatedAt: now,
  };

  const db = await getDb();
  const tx = db.transaction(['projects', 'captures', 'captureImages'], 'readwrite');
  await tx.objectStore('captures').put(capture);
  await tx.objectStore('captureImages').put({
    captureId: capture.id,
    screenshot: input.screenshot,
    thumbnail: input.thumbnail,
  });
  const storedProject = await tx.objectStore('projects').get(project.id);
  if (storedProject) {
    await tx.objectStore('projects').put({ ...storedProject, updatedAt: now });
  }
  await tx.done;
  return capture;
}

export interface CaptureMetaPatch {
  title?: string;
  description?: string;
  tags?: string[];
}

export async function updateCaptureMeta(id: string, patch: CaptureMetaPatch): Promise<Capture> {
  const db = await getDb();
  const tx = db.transaction('captures', 'readwrite');
  const capture = await tx.store.get(id);
  if (!capture) throw new NotFoundError('Capture not found');
  const updated: Capture = {
    ...capture,
    ...(patch.title !== undefined ? { title: patch.title.trim().slice(0, 300) } : {}),
    ...(patch.description !== undefined ? { description: patch.description.slice(0, 20_000) } : {}),
    ...(patch.tags !== undefined ? { tags: normalizeTags(patch.tags) } : {}),
    updatedAt: Date.now(),
  };
  await tx.store.put(updated);
  await tx.done;
  return updated;
}

export function normalizeTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of tags) {
    const tag = raw.trim().slice(0, 60);
    const key = tag.toLowerCase();
    if (tag && !seen.has(key)) {
      seen.add(key);
      result.push(tag);
    }
  }
  return result.slice(0, 50);
}

type CascadeTx = IDBPTransaction<
  OverlayNotesDB,
  ('projects' | 'captures' | 'captureImages' | 'annotations')[],
  'readwrite'
>;

async function deleteCaptureInTx(tx: CascadeTx, captureId: string): Promise<void> {
  const annotations = tx.objectStore('annotations');
  const keys = await annotations.index('byCaptureId').getAllKeys(captureId);
  for (const key of keys) await annotations.delete(key);
  await tx.objectStore('captureImages').delete(captureId);
  await tx.objectStore('captures').delete(captureId);
}

export async function deleteCapture(id: string): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(['projects', 'captures', 'captureImages', 'annotations'], 'readwrite');
  await deleteCaptureInTx(tx, id);
  await tx.done;
}

/** Copy a capture with its screenshot and annotations (new ids). */
export async function duplicateCapture(id: string): Promise<Capture> {
  const db = await getDb();
  const tx = db.transaction(['captures', 'captureImages', 'annotations'], 'readwrite');
  const capture = await tx.objectStore('captures').get(id);
  const images = await tx.objectStore('captureImages').get(id);
  if (!capture || !images) throw new NotFoundError('Capture not found');
  const annotations = await tx.objectStore('annotations').index('byCaptureId').getAll(id);
  const now = Date.now();
  const copy: Capture = {
    ...capture,
    id: createId(),
    title: `${capture.title} (copy)`.slice(0, 300),
    createdAt: now,
    updatedAt: now,
  };
  await tx.objectStore('captures').put(copy);
  await tx.objectStore('captureImages').put({ ...images, captureId: copy.id });
  for (const annotation of annotations) {
    await tx.objectStore('annotations').put({ ...annotation, id: createId(), captureId: copy.id });
  }
  await tx.done;
  return copy;
}

// ---------------------------------------------------------------------------
// Annotations
// ---------------------------------------------------------------------------

export async function getAnnotations(captureId: string): Promise<Annotation[]> {
  const db = await getDb();
  const annotations = await db.getAllFromIndex('annotations', 'byCaptureId', captureId);
  return annotations.sort((a, b) => a.zIndex - b.zIndex);
}

/** Text that the notes manager searches for a capture's annotations. */
export function buildSearchText(annotations: readonly Annotation[]): string {
  const parts: string[] = [];
  for (const annotation of annotations) {
    if ((annotation.type === 'text' || annotation.type === 'sticky-note') && annotation.text.trim()) {
      parts.push(annotation.text.trim());
    }
  }
  return parts.join('\n').slice(0, 200_000);
}

/**
 * Replace the full annotation set of a capture in one transaction.
 * Idempotent: saving the same list twice yields the same stored state.
 * Array order defines z-order.
 */
export async function replaceAnnotations(
  captureId: string,
  annotations: readonly Annotation[],
): Promise<Capture> {
  for (const annotation of annotations) {
    if (annotation.captureId !== captureId) {
      throw new Error('Annotation belongs to a different capture');
    }
  }
  const db = await getDb();
  const tx = db.transaction(['captures', 'annotations'], 'readwrite');
  const captures = tx.objectStore('captures');
  const store = tx.objectStore('annotations');
  const capture = await captures.get(captureId);
  if (!capture) {
    tx.abort();
    await tx.done.catch(() => undefined);
    throw new NotFoundError('This capture no longer exists (it may have been deleted).');
  }

  const nextIds = new Set(annotations.map((a) => a.id));
  const existingKeys = await store.index('byCaptureId').getAllKeys(captureId);
  for (const key of existingKeys) {
    if (!nextIds.has(key)) await store.delete(key);
  }
  for (const [index, annotation] of annotations.entries()) {
    await store.put({ ...annotation, zIndex: index });
  }
  const updated: Capture = {
    ...capture,
    annotationCount: annotations.length,
    searchText: buildSearchText(annotations),
    updatedAt: Date.now(),
  };
  await captures.put(updated);
  await tx.done;
  return updated;
}

// ---------------------------------------------------------------------------
// Whole-database operations
// ---------------------------------------------------------------------------

export async function deleteAllData(): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(['projects', 'captures', 'captureImages', 'annotations'], 'readwrite');
  await Promise.all([
    tx.objectStore('projects').clear(),
    tx.objectStore('captures').clear(),
    tx.objectStore('captureImages').clear(),
    tx.objectStore('annotations').clear(),
    tx.done,
  ]);
}

export interface StorageUsage {
  usageBytes: number | null;
  quotaBytes: number | null;
  persisted: boolean | null;
  captureCount: number;
  projectCount: number;
}

export async function getStorageUsage(): Promise<StorageUsage> {
  const db = await getDb();
  const [captureCount, projectCount] = await Promise.all([db.count('captures'), db.count('projects')]);
  let usageBytes: number | null = null;
  let quotaBytes: number | null = null;
  let persisted: boolean | null = null;
  try {
    const estimate = await navigator.storage.estimate();
    usageBytes = estimate.usage ?? null;
    quotaBytes = estimate.quota ?? null;
    persisted = await navigator.storage.persisted();
  } catch {
    // Storage manager unavailable — leave as unknown.
  }
  return { usageBytes, quotaBytes, persisted, captureCount, projectCount };
}
