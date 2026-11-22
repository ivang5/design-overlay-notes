/**
 * Where new captures of a Figma file go: the file's own project (default) or
 * a project the user chose for it. Stored in chrome.storage.local as
 * { [projectKey]: projectId }; trusted extension contexts only.
 */
import { z } from 'zod';
import { idSchema } from '../shared/schemas';

const KEY = 'captureTargets';
const targetsSchema = z.record(z.string().min(1).max(200), idSchema);
export type CaptureTargets = z.infer<typeof targetsSchema>;

export async function getCaptureTargets(): Promise<CaptureTargets> {
  const parsed = targetsSchema.safeParse((await chrome.storage.local.get(KEY))[KEY]);
  return parsed.success ? parsed.data : {};
}

/** Route a file's new captures to `projectId` (null: back to the file's own project). */
export async function setCaptureTarget(projectKey: string, projectId: string | null): Promise<void> {
  const targets = await getCaptureTargets();
  if (projectId) targets[projectKey] = projectId;
  else delete targets[projectKey];
  await chrome.storage.local.set({ [KEY]: targets });
}

/** A project was deleted: files routed to it go back to their own projects. */
export async function forgetCaptureTargetsFor(projectId: string): Promise<void> {
  const targets = await getCaptureTargets();
  const kept = Object.fromEntries(Object.entries(targets).filter(([, id]) => id !== projectId));
  if (Object.keys(kept).length !== Object.keys(targets).length) await chrome.storage.local.set({ [KEY]: kept });
}

/** Subscribe to changes (from any extension page). */
export function onCaptureTargetsChange(listener: (targets: CaptureTargets) => void): () => void {
  const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area !== 'local' || !(KEY in changes)) return;
    const parsed = targetsSchema.safeParse(changes[KEY]!.newValue);
    listener(parsed.success ? parsed.data : {});
  };
  chrome.storage.onChanged.addListener(onChanged);
  return () => chrome.storage.onChanged.removeListener(onChanged);
}
