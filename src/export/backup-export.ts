import { zipSync, type Zippable } from 'fflate';
import { getDb } from '../database/db';
import { BACKUP_FORMAT, BACKUP_FORMAT_VERSION, DB_VERSION } from '../shared/constants';
import { IMAGE_TYPES, type BackupManifest, type ImageIndexEntry, type ImageMime } from './backup-format';

function json(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value, null, 2));
}

function extensionFor(type: string): string {
  return IMAGE_TYPES[type as ImageMime] ?? 'png';
}

/** Build a full backup of every local record and image. */
export async function createBackupArchive(appVersion: string): Promise<Blob> {
  const db = await getDb();
  const tx = db.transaction(['projects', 'captures', 'annotations', 'captureImages'], 'readonly');
  const [projects, captures, annotations, images] = await Promise.all([
    tx.objectStore('projects').getAll(),
    tx.objectStore('captures').getAll(),
    tx.objectStore('annotations').getAll(),
    tx.objectStore('captureImages').getAll(),
  ]);
  await tx.done;

  const files: Zippable = {};
  const index: ImageIndexEntry[] = [];
  for (const image of images) {
    const screenshotType = (image.screenshot.type in IMAGE_TYPES ? image.screenshot.type : 'image/png') as ImageMime;
    const screenshotPath = `images/${image.captureId}/screenshot.${extensionFor(screenshotType)}`;
    // Images are already compressed: store them without re-deflating.
    files[screenshotPath] = [new Uint8Array(await image.screenshot.arrayBuffer()), { level: 0 }];
    let thumbnailPath: string | null = null;
    if (image.thumbnail) {
      thumbnailPath = `images/${image.captureId}/thumbnail.${extensionFor(image.thumbnail.type)}`;
      files[thumbnailPath] = [new Uint8Array(await image.thumbnail.arrayBuffer()), { level: 0 }];
    }
    index.push({ captureId: image.captureId, screenshotPath, screenshotType, thumbnailPath });
  }

  const manifest: BackupManifest = {
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
    appVersion,
    dbVersion: DB_VERSION,
    exportedAt: Date.now(),
    counts: { projects: projects.length, captures: captures.length, annotations: annotations.length },
  };

  files['manifest.json'] = json(manifest);
  files['data/projects.json'] = json(projects);
  files['data/captures.json'] = json(captures);
  files['data/annotations.json'] = json(annotations);
  files['data/images.json'] = json(index);

  const zipped = zipSync(files, { level: 6 });
  return new Blob([zipped as Uint8Array<ArrayBuffer>], { type: 'application/zip' });
}

export function backupFileName(now = new Date()): string {
  return `design-overlay-notes-backup_${now.toISOString().slice(0, 19).replace(/[:T]/g, '-')}.zip`;
}
