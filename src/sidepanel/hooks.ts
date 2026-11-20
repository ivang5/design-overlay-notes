import { useCallback, useEffect, useRef, useState } from 'react';
import { getCaptureImages, listCaptures, listProjects } from '../database/repository';
import { dataChangeSchema, sendToBackground, type ActiveTabInfo, type DataChange } from '../shared/messages';
import type { Capture, Project } from '../shared/schemas';

/** Subscribe to DATA_CHANGED broadcasts from other extension contexts. */
export function useDataChanges(onChange: (change: DataChange) => void): void {
  const ref = useRef(onChange);
  ref.current = onChange;
  useEffect(() => {
    const listener = (message: unknown, sender: chrome.runtime.MessageSender) => {
      if (sender.id !== chrome.runtime.id) return false;
      if (typeof message !== 'object' || message === null || (message as { type?: unknown }).type !== 'DATA_CHANGED') {
        return false;
      }
      const parsed = dataChangeSchema.safeParse((message as { change?: unknown }).change);
      if (parsed.success) ref.current(parsed.data);
      return false; // never respond: the service worker owns responses
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);
}

export interface Library {
  projects: Project[];
  captures: Capture[];
  loading: boolean;
  error: string | null;
  reload: () => void;
}

export function useLibrary(): Library {
  const [projects, setProjects] = useState<Project[]>([]);
  const [captures, setCaptures] = useState<Capture[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    try {
      const [p, c] = await Promise.all([listProjects(), listCaptures()]);
      setProjects(p);
      setCaptures(c);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  const reload = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void load(), 120);
  }, [load]);

  useEffect(() => {
    void load();
  }, [load]);

  useDataChanges(reload);

  return { projects, captures, loading, error, reload };
}

export function useWindowId(): number | null {
  const [windowId, setWindowId] = useState<number | null>(null);
  useEffect(() => {
    chrome.windows
      .getCurrent()
      .then((w) => setWindowId(w.id ?? null))
      .catch(() => setWindowId(null));
  }, []);
  return windowId;
}

const EMPTY_TAB: ActiveTabInfo = { tabId: null, url: null, supported: false, projectKey: null, overlay: null };

/** What the active tab in this window is (as far as the extension may know). */
export function useActiveTab(windowId: number | null): { info: ActiveTabInfo; refresh: () => void } {
  const [info, setInfo] = useState<ActiveTabInfo>(EMPTY_TAB);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchInfo = useCallback(async () => {
    if (windowId === null) return;
    try {
      setInfo(await sendToBackground({ type: 'PANEL_GET_ACTIVE_TAB', windowId }));
    } catch {
      setInfo(EMPTY_TAB);
    }
  }, [windowId]);

  const refresh = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void fetchInfo(), 150);
  }, [fetchInfo]);

  useEffect(() => {
    void fetchInfo();
    const onActivated = (activeInfo: chrome.tabs.OnActivatedInfo) => {
      if (activeInfo.windowId === windowId) refresh();
    };
    const onUpdated = (_tabId: number, change: chrome.tabs.OnUpdatedInfo) => {
      if (change.status === 'complete' || change.url !== undefined) refresh();
    };
    chrome.tabs.onActivated.addListener(onActivated);
    chrome.tabs.onUpdated.addListener(onUpdated);
    const onFocus = () => refresh();
    window.addEventListener('focus', onFocus);
    // The overlay state can change from the page itself; poll lightly.
    const interval = setInterval(() => void fetchInfo(), 4_000);
    return () => {
      chrome.tabs.onActivated.removeListener(onActivated);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      window.removeEventListener('focus', onFocus);
      clearInterval(interval);
    };
  }, [fetchInfo, refresh, windowId]);

  useDataChanges(refresh);
  return { info, refresh };
}

// Thumbnails: object URLs cached for the lifetime of the panel.
const thumbnailCache = new Map<string, Promise<string | null>>();

export function forgetThumbnail(captureId: string): void {
  const cached = thumbnailCache.get(captureId);
  thumbnailCache.delete(captureId);
  void cached?.then((url) => url && URL.revokeObjectURL(url));
}

export function useThumbnail(captureId: string): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    let promise = thumbnailCache.get(captureId);
    if (!promise) {
      promise = getCaptureImages(captureId).then((images) => {
        const blob = images?.thumbnail ?? images?.screenshot;
        return blob ? URL.createObjectURL(blob) : null;
      });
      thumbnailCache.set(captureId, promise);
    }
    void promise.then((value) => {
      if (!cancelled) setUrl(value);
    });
    return () => {
      cancelled = true;
    };
  }, [captureId]);
  return url;
}
