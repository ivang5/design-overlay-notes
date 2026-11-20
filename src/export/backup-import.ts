/**
 * Validated backup restore. The archive is treated strictly as data:
 * only allowlisted paths are read, every JSON record is validated with Zod,
 * relationships are checked, and images are verified by magic bytes before
 * anything is written. Nothing from the archive is ever executed.
 *
 * Merge policy:
 *  - Projects are matched by Figma file key; imported captures join the
 *    existing local project for the same file.
 *  - Captures whose id already exists locally are skipped (re-importing the
 *    same backup is harmless).
 */
import { unzipSync } from 'fflate';
import { z } from 'zod';
import { getDb } from '../database/db';
import {
  annotationSchema,
  captureSchema,
  projectSchema,
  type Annotation,
  type Capture,
  type Project,
} from '../shared/schemas';
import {
  ALLOWED_ENTRY_RE,
  MAX_BACKUP_FILE_BYTES,
  MAX_ENTRY_BYTES,
  MAX_TOTAL_UNCOMPRESSED_BYTES,
  backupManifestSchema,
  imageIndexEntrySchema,
  sniffImageType,
} from './backup-format';

export class BackupImportError extends Error {
  override name = 'BackupImportError';
}

export interface ImportReport {
  projectsAdded: number;
  projectsMerged: number;
  capturesAdded: number;
  capturesSkipped: number;
  annotationsAdded: number;
}

function readJson<T>(files: Record<string, Uint8Array>, path: string, schema: z.ZodType<T>): T {
  const bytes = files[path];
  if (!bytes) throw new BackupImportError(`Backup is missing ${path}`);
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new BackupImportError(`${path} is not valid JSON`);
  }
  const result = schema.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new BackupImportError(`${path} failed validation${issue ? `: ${issue.path.join('.')} ${issue.message}` : ''}`);
  }
  return result.data;
}

export interface ParsedBackup {
  projects: Project[];
  captures: Capture[];
  annotations: Annotation[];
  images: Map<string, { screenshot: Blob; thumbnail: Blob | null }>;
}

/** Unpack and fully validate an archive without touching the database. */
export function parseBackupArchive(bytes: Uint8Array): ParsedBackup {
  if (bytes.byteLength > MAX_BACKUP_FILE_BYTES) throw new BackupImportError('Backup file is too large');
  let total = 0;
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, {
      filter(file) {
        if (!ALLOWED_ENTRY_RE.test(file.name)) return false; // ignore anything unexpected
        if (file.originalSize > MAX_ENTRY_BYTES) throw new BackupImportError(`${file.name} is too large`);
        total += file.originalSize;
        if (total > MAX_TOTAL_UNCOMPRESSED_BYTES) throw new BackupImportError('Backup is too large when unpacked');
        return true;
      },
    });
  } catch (error) {
    if (error instanceof BackupImportError) throw error;
    throw new BackupImportError('This file is not a valid backup archive (ZIP could not be read)');
  }

  readJson(files, 'manifest.json', backupManifestSchema);
  const projects = readJson(files, 'data/projects.json', z.array(projectSchema).max(100_000));
  const captures = readJson(files, 'data/captures.json', z.array(captureSchema).max(100_000));
  const annotations = readJson(files, 'data/annotations.json', z.array(annotationSchema).max(50_000_000));
  const index = readJson(files, 'data/images.json', z.array(imageIndexEntrySchema).max(100_000));

  const projectIds = new Set(projects.map((p) => p.id));
  const captureIds = new Set<string>();
  for (const capture of captures) {
    if (!projectIds.has(capture.projectId)) {
      throw new BackupImportError(`Capture ${capture.id} references a missing project`);
    }
    if (captureIds.has(capture.id)) throw new BackupImportError(`Duplicate capture id ${capture.id}`);
    captureIds.add(capture.id);
  }
  for (const annotation of annotations) {
    if (!captureIds.has(annotation.captureId)) {
      throw new BackupImportError(`Annotation ${annotation.id} references a missing capture`);
    }
  }

  const images = new Map<string, { screenshot: Blob; thumbnail: Blob | null }>();
  for (const entry of index) {
    if (!captureIds.has(entry.captureId)) continue;
    const expectedPrefix = `images/${entry.captureId}/`;
    if (!entry.screenshotPath.startsWith(expectedPrefix)) throw new BackupImportError('Unexpected image path');
    const screenshotBytes = files[entry.screenshotPath];
    if (!screenshotBytes) throw new BackupImportError(`Missing screenshot for capture ${entry.captureId}`);
    const screenshotType = sniffImageType(screenshotBytes);
    if (!screenshotType) throw new BackupImportError(`Screenshot for ${entry.captureId} is not a supported image`);
    let thumbnail: Blob | null = null;
    if (entry.thumbnailPath && entry.thumbnailPath.startsWith(expectedPrefix)) {
      const thumbBytes = files[entry.thumbnailPath];
      const thumbType = thumbBytes ? sniffImageType(thumbBytes) : null;
      if (thumbBytes && thumbType) thumbnail = new Blob([thumbBytes as Uint8Array<ArrayBuffer>], { type: thumbType });
    }
    images.set(entry.captureId, {
      screenshot: new Blob([screenshotBytes as Uint8Array<ArrayBuffer>], { type: screenshotType }),
      thumbnail,
    });
  }
  for (const capture of captures) {
    if (!images.has(capture.id)) throw new BackupImportError(`Missing screenshot for capture ${capture.id}`);
  }

  return { projects, captures, annotations, images };
}

/** Write a validated backup into the local database. */
export async function importParsedBackup(backup: ParsedBackup): Promise<ImportReport> {
  const report: ImportReport = {
    projectsAdded: 0,
    projectsMerged: 0,
    capturesAdded: 0,
    capturesSkipped: 0,
    annotationsAdded: 0,
  };
  const db = await getDb();
  const tx = db.transaction(['projects', 'captures', 'captureImages', 'annotations'], 'readwrite');
  const projectStore = tx.objectStore('projects');
  const captureStore = tx.objectStore('captures');

  // Map imported project ids to local ones (merging by file key).
  const projectIdMap = new Map<string, string>();
  for (const project of backup.projects) {
    const byId = await projectStore.get(project.id);
    if (byId) {
      projectIdMap.set(project.id, byId.id);
      report.projectsMerged++;
      continue;
    }
    const byKey = project.fileKey ? await projectStore.index('byFileKey').get(project.fileKey) : undefined;
    if (byKey) {
      projectIdMap.set(project.id, byKey.id);
      report.projectsMerged++;
      continue;
    }
    await projectStore.put(project);
    projectIdMap.set(project.id, project.id);
    report.projectsAdded++;
  }

  const imported = new Set<string>();
  for (const capture of backup.captures) {
    if (await captureStore.get(capture.id)) {
      report.capturesSkipped++;
      continue;
    }
    const images = backup.images.get(capture.id)!;
    await captureStore.put({ ...capture, projectId: projectIdMap.get(capture.projectId) ?? capture.projectId });
    await tx.objectStore('captureImages').put({ captureId: capture.id, ...images });
    imported.add(capture.id);
    report.capturesAdded++;
  }

  for (const annotation of backup.annotations) {
    if (!imported.has(annotation.captureId)) continue;
    await tx.objectStore('annotations').put(annotation);
    report.annotationsAdded++;
  }

  await tx.done;
  return report;
}

export async function importBackupFile(file: Blob): Promise<ImportReport> {
  if (file.size > MAX_BACKUP_FILE_BYTES) throw new BackupImportError('Backup file is too large');
  const parsed = parseBackupArchive(new Uint8Array(await file.arrayBuffer()));
  return importParsedBackup(parsed);
}
