/**
 * Backup archive format (ZIP):
 *
 *   manifest.json                 format id, format version, export time, counts
 *   data/projects.json            Project[]
 *   data/captures.json            Capture[]
 *   data/annotations.json         Annotation[]
 *   data/images.json              ImageIndexEntry[]
 *   images/<captureId>/screenshot.png
 *   images/<captureId>/thumbnail.webp
 */
import { z } from 'zod';
import { BACKUP_FORMAT, BACKUP_FORMAT_VERSION } from '../shared/constants';
import { idSchema } from '../shared/schemas';

export const backupManifestSchema = z.object({
  format: z.literal(BACKUP_FORMAT),
  formatVersion: z.number().int().min(1).max(BACKUP_FORMAT_VERSION),
  appVersion: z.string().max(50),
  dbVersion: z.number().int().positive(),
  exportedAt: z.number().int().nonnegative(),
  counts: z.object({
    projects: z.number().int().nonnegative(),
    captures: z.number().int().nonnegative(),
    annotations: z.number().int().nonnegative(),
  }),
});
export type BackupManifest = z.infer<typeof backupManifestSchema>;

export const IMAGE_TYPES = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
} as const;
export type ImageMime = keyof typeof IMAGE_TYPES;

export const imageIndexEntrySchema = z.object({
  captureId: idSchema,
  screenshotPath: z.string().max(200),
  screenshotType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
  thumbnailPath: z.string().max(200).nullable(),
});
export type ImageIndexEntry = z.infer<typeof imageIndexEntrySchema>;

/** Only these paths are ever read from an imported archive. */
export const ALLOWED_ENTRY_RE =
  /^(manifest\.json|data\/(projects|captures|annotations|images)\.json|images\/[A-Za-z0-9_-]{1,64}\/(screenshot|thumbnail)\.(png|jpg|webp))$/;

export const MAX_BACKUP_FILE_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB
export const MAX_ENTRY_BYTES = 200 * 1024 * 1024; // 200 MiB per file
export const MAX_TOTAL_UNCOMPRESSED_BYTES = 4 * 1024 * 1024 * 1024; // 4 GiB

/** Recognize PNG / JPEG / WebP by magic bytes (never trust the extension alone). */
export function sniffImageType(bytes: Uint8Array): ImageMime | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (
    bytes.length >= 12 &&
    String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!) === 'RIFF' &&
    String.fromCharCode(bytes[8]!, bytes[9]!, bytes[10]!, bytes[11]!) === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}
