/**
 * IndexedDB schema for the extension origin.
 *
 * IMPORTANT: only import this module from extension-owned contexts (service
 * worker, side panel, review page). A content script calling indexedDB would
 * open the *Figma page's* database, not ours.
 */
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import { DB_NAME, DB_VERSION } from '../shared/constants';
import type { Annotation, Capture, CaptureImages, Project } from '../shared/schemas';

export interface OverlayNotesDB extends DBSchema {
  projects: {
    key: string;
    value: Project;
    indexes: { byFileKey: string; byUpdatedAt: number };
  };
  captures: {
    key: string;
    value: Capture;
    indexes: { byProjectId: string; byCreatedAt: number };
  };
  captureImages: {
    key: string;
    value: CaptureImages;
  };
  annotations: {
    key: string;
    value: Annotation;
    indexes: { byCaptureId: string };
  };
}

export type OverlayDatabase = IDBPDatabase<OverlayNotesDB>;

/**
 * Versioned migrations. Each entry upgrades the schema from `version - 1` to
 * `version`. Never edit a released migration — add a new one and bump
 * DB_VERSION in shared/constants.ts.
 */
const MIGRATIONS: Record<number, (db: OverlayDatabase) => void> = {
  1: (db) => {
    const projects = db.createObjectStore('projects', { keyPath: 'id' });
    projects.createIndex('byFileKey', 'fileKey');
    projects.createIndex('byUpdatedAt', 'updatedAt');

    const captures = db.createObjectStore('captures', { keyPath: 'id' });
    captures.createIndex('byProjectId', 'projectId');
    captures.createIndex('byCreatedAt', 'createdAt');

    db.createObjectStore('captureImages', { keyPath: 'captureId' });

    const annotations = db.createObjectStore('annotations', { keyPath: 'id' });
    annotations.createIndex('byCaptureId', 'captureId');
  },
};

let dbPromise: Promise<OverlayDatabase> | null = null;

export function getDb(): Promise<OverlayDatabase> {
  if (!dbPromise) {
    dbPromise = openDB<OverlayNotesDB>(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion, newVersion) {
        const target = newVersion ?? DB_VERSION;
        for (let v = oldVersion + 1; v <= target; v++) {
          const migrate = MIGRATIONS[v];
          if (!migrate) throw new Error(`Missing IndexedDB migration for version ${v}`);
          migrate(db);
        }
      },
      blocked() {
        console.warn('[overlay-notes] Database upgrade blocked by another open context');
      },
      blocking() {
        // A newer version wants to upgrade: close so it is not blocked.
        void dbPromise?.then((db) => db.close());
        dbPromise = null;
      },
      terminated() {
        dbPromise = null;
      },
    }).catch((error: unknown) => {
      dbPromise = null;
      throw error;
    });
  }
  return dbPromise;
}

/** Test helper: forget the cached connection (used with fake-indexeddb). */
export async function closeDbForTests(): Promise<void> {
  if (dbPromise) {
    const db = await dbPromise;
    db.close();
    dbPromise = null;
  }
}
