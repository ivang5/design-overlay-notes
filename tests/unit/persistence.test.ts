import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { strToU8, unzipSync, zipSync } from 'fflate';
import { beforeEach, describe, expect, it } from 'vitest';
import { closeDbForTests } from '../../src/database/db';
import {
  createCapture,
  deleteAllData,
  deleteCapture,
  deleteProject,
  duplicateCapture,
  getAnnotations,
  getCapture,
  getCaptureImages,
  listCaptures,
  listProjects,
  replaceAnnotations,
  updateCaptureMeta,
  type NewCaptureInput,
} from '../../src/database/repository';
import { createBackupArchive } from '../../src/export/backup-export';
import { BackupImportError, importParsedBackup, parseBackupArchive } from '../../src/export/backup-import';
import { annotationListSchema, captureSchema } from '../../src/shared/schemas';
import type { Annotation } from '../../src/shared/schemas';
import { allTypes, stroke } from './fixtures';

// 1×1 transparent PNG.
const PNG_BYTES = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='),
  (c) => c.charCodeAt(0),
);

function input(overrides: Partial<NewCaptureInput> = {}): NewCaptureInput {
  return {
    metadata: {
      pageUrl: 'https://www.figma.com/design/AbCdEf1234567890/Checkout?node-id=1-2',
      pageTitle: 'Checkout – Figma',
      viewportCssWidth: 1440,
      viewportCssHeight: 900,
      devicePixelRatio: 2,
      scrollX: 0,
      scrollY: 0,
      visualViewportScale: 1,
      visualViewportOffsetLeft: 0,
      visualViewportOffsetTop: 0,
    },
    pageUrl: 'https://www.figma.com/design/AbCdEf1234567890/Checkout?node-id=1-2',
    projectKey: 'AbCdEf1234567890',
    projectName: 'Checkout',
    screenshot: new Blob([PNG_BYTES], { type: 'image/png' }),
    thumbnail: null,
    screenshotPixelWidth: 2880,
    screenshotPixelHeight: 1800,
    ...overrides,
  };
}

function forCapture(captureId: string, annotations: Annotation[]): Annotation[] {
  return annotations.map((a) => ({ ...a, captureId }) as Annotation);
}

async function freshDb() {
  await closeDbForTests();
  globalThis.indexedDB = new IDBFactory();
}

describe('repository', () => {
  beforeEach(freshDb);

  it('creates a capture inside a project for the Figma file', async () => {
    const capture = await createCapture(input());
    expect(captureSchema.safeParse(capture).success).toBe(true);
    expect(capture.pageTitle).toBe('Checkout');
    const projects = await listProjects();
    expect(projects).toHaveLength(1);
    expect(projects[0]?.name).toBe('Checkout');
    expect(capture.projectId).toBe(projects[0]?.id);
  });

  it('groups captures of the same file into one project', async () => {
    const a = await createCapture(input());
    const b = await createCapture(input());
    expect(a.projectId).toBe(b.projectId);
    const other = await createCapture(input({ projectKey: 'ZzZzZz1234567890', projectName: 'Other' }));
    expect(other.projectId).not.toBe(a.projectId);
    expect(await listProjects()).toHaveLength(2);
  });

  it('round-trips annotations and keeps the screenshot intact', async () => {
    const capture = await createCapture(input());
    const annotations = forCapture(capture.id, allTypes());
    const updated = await replaceAnnotations(capture.id, annotations);
    expect(updated.annotationCount).toBe(annotations.length);
    expect(updated.searchText).toContain('Check padding');

    const stored = await getAnnotations(capture.id);
    expect(stored.map((a) => a.id)).toEqual(annotations.map((a) => a.id));
    expect(stored.map((a) => a.zIndex)).toEqual(annotations.map((_, i) => i));
    expect(annotationListSchema.safeParse(stored).success).toBe(true);

    const images = await getCaptureImages(capture.id);
    expect(new Uint8Array(await images!.screenshot.arrayBuffer())).toEqual(PNG_BYTES);
  });

  it('replaceAnnotations is idempotent and removes deleted marks', async () => {
    const capture = await createCapture(input());
    const annotations = forCapture(capture.id, allTypes());
    await replaceAnnotations(capture.id, annotations);
    await replaceAnnotations(capture.id, annotations);
    expect(await getAnnotations(capture.id)).toHaveLength(annotations.length);
    await replaceAnnotations(capture.id, annotations.slice(0, 2));
    expect(await getAnnotations(capture.id)).toHaveLength(2);
  });

  it('refuses annotations that belong to another capture', async () => {
    const capture = await createCapture(input());
    await expect(replaceAnnotations(capture.id, forCapture('someone-else', [stroke()]))).rejects.toThrow();
  });

  it('refuses saving to a deleted capture instead of resurrecting it', async () => {
    const capture = await createCapture(input());
    await deleteCapture(capture.id);
    await expect(replaceAnnotations(capture.id, [])).rejects.toThrow(/no longer exists/);
  });

  it('cascades capture deletion to images and annotations', async () => {
    const capture = await createCapture(input());
    await replaceAnnotations(capture.id, forCapture(capture.id, [stroke()]));
    await deleteCapture(capture.id);
    expect(await getCapture(capture.id)).toBeUndefined();
    expect(await getCaptureImages(capture.id)).toBeUndefined();
    expect(await getAnnotations(capture.id)).toHaveLength(0);
  });

  it('cascades project deletion', async () => {
    const capture = await createCapture(input());
    await deleteProject(capture.projectId);
    expect(await listCaptures()).toHaveLength(0);
    expect(await listProjects()).toHaveLength(0);
  });

  it('duplicates a capture with fresh ids', async () => {
    const capture = await createCapture(input());
    await replaceAnnotations(capture.id, forCapture(capture.id, allTypes()));
    const copy = await duplicateCapture(capture.id);
    expect(copy.id).not.toBe(capture.id);
    const copied = await getAnnotations(copy.id);
    expect(copied).toHaveLength(allTypes().length);
    expect(copied.every((a) => a.captureId === copy.id)).toBe(true);
    expect(await getAnnotations(capture.id)).toHaveLength(allTypes().length);
  });

  it('updates title, description and normalized tags', async () => {
    const capture = await createCapture(input());
    const updated = await updateCaptureMeta(capture.id, {
      title: '  Login  ',
      description: 'notes',
      tags: ['Bug', 'bug', ' Question ', ''],
    });
    expect(updated.title).toBe('Login');
    expect(updated.tags).toEqual(['Bug', 'Question']);
  });

  it('deletes everything', async () => {
    await createCapture(input());
    await deleteAllData();
    expect(await listCaptures()).toHaveLength(0);
    expect(await listProjects()).toHaveLength(0);
  });
});

describe('backup', () => {
  beforeEach(freshDb);

  async function seed() {
    const capture = await createCapture(input());
    await replaceAnnotations(capture.id, forCapture(capture.id, allTypes()));
    await updateCaptureMeta(capture.id, { tags: ['Question'] });
    return capture;
  }

  it('exports and restores into an empty profile', async () => {
    const capture = await seed();
    const archive = new Uint8Array(await (await createBackupArchive('0.1.0')).arrayBuffer());

    await freshDb();
    const report = await importParsedBackup(parseBackupArchive(archive));
    expect(report).toMatchObject({ projectsAdded: 1, capturesAdded: 1, annotationsAdded: allTypes().length });

    const restored = await getCapture(capture.id);
    expect(restored?.tags).toEqual(['Question']);
    expect(await getAnnotations(capture.id)).toHaveLength(allTypes().length);
    const images = await getCaptureImages(capture.id);
    expect(new Uint8Array(await images!.screenshot.arrayBuffer())).toEqual(PNG_BYTES);
  });

  it('skips captures that already exist and merges projects by file key', async () => {
    await seed();
    const archive = new Uint8Array(await (await createBackupArchive('0.1.0')).arrayBuffer());
    const report = await importParsedBackup(parseBackupArchive(archive));
    expect(report).toMatchObject({ capturesAdded: 0, capturesSkipped: 1, projectsMerged: 1 });
    expect(await listCaptures()).toHaveLength(1);
  });

  it('merges an imported project into an existing local project for the same file', async () => {
    await seed();
    const archive = new Uint8Array(await (await createBackupArchive('0.1.0')).arrayBuffer());
    await freshDb();
    const local = await createCapture(input()); // same file key, different project id
    await importParsedBackup(parseBackupArchive(archive));
    const projects = await listProjects();
    expect(projects).toHaveLength(1);
    expect((await listCaptures()).every((c) => c.projectId === local.projectId)).toBe(true);
  });

  it('rejects archives that are not backups', () => {
    expect(() => parseBackupArchive(strToU8('definitely not a zip'))).toThrow(BackupImportError);
    expect(() => parseBackupArchive(zipSync({ 'hello.txt': strToU8('hi') }))).toThrow(/manifest\.json/);
  });

  it('rejects tampered records and broken relationships', async () => {
    await seed();
    const archive = new Uint8Array(await (await createBackupArchive('0.1.0')).arrayBuffer());
    const files = unzipSync(archive);

    const badAnnotations = { ...files, 'data/annotations.json': strToU8('[{"id":"x","type":"script"}]') };
    expect(() => parseBackupArchive(zipSync(badAnnotations))).toThrow(/annotations\.json failed validation/);

    const orphan = JSON.parse(new TextDecoder().decode(files['data/captures.json']));
    orphan[0].projectId = 'missingproject';
    const badRelations = { ...files, 'data/captures.json': strToU8(JSON.stringify(orphan)) };
    expect(() => parseBackupArchive(zipSync(badRelations))).toThrow(/missing project/);

    const screenshotPath = Object.keys(files).find((p) => p.endsWith('screenshot.png'))!;
    const notAnImage = { ...files, [screenshotPath]: strToU8('<html>not an image</html>') };
    expect(() => parseBackupArchive(zipSync(notAnImage))).toThrow(/not a supported image/);
  });

  it('ignores unexpected files in the archive', async () => {
    await seed();
    const archive = new Uint8Array(await (await createBackupArchive('0.1.0')).arrayBuffer());
    const files = { ...unzipSync(archive), '../../evil.js': strToU8('alert(1)'), 'extra/readme.txt': strToU8('x') };
    expect(() => parseBackupArchive(zipSync(files))).not.toThrow();
  });
});
