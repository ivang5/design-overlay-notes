import { useMemo, useState } from 'react';
import { Camera, Lock, Search, Settings, X } from 'lucide-react';
import { DEFAULT_SHORTCUTS } from '../shared/constants';
import { errorMessage, sendToBackground } from '../shared/messages';
import type { Capture, Project } from '../shared/schemas';
import { InlineMessage } from './components/common';
import { ProjectSection } from './components/ProjectSection';
import { SettingsView } from './components/SettingsView';
import { useActiveTab, useLibrary, useWindowId } from './hooks';

function matches(capture: Capture, project: Project | undefined, terms: string[]): boolean {
  if (terms.length === 0) return true;
  const haystack = [
    capture.title,
    capture.description,
    capture.pageTitle ?? '',
    capture.searchText,
    capture.tags.join(' '),
    project?.name ?? '',
  ]
    .join('\n')
    .toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

export function App() {
  const windowId = useWindowId();
  const { info } = useActiveTab(windowId);
  const library = useLibrary();
  const [view, setView] = useState<'library' | 'settings'>('library');
  const [query, setQuery] = useState('');
  const [tagFilter, setTagFilter] = useState<string[]>([]);
  const [notice, setNotice] = useState<{ tone: 'error' | 'info'; text: string } | null>(null);
  const [capturing, setCapturing] = useState(false);

  const projectsById = useMemo(() => new Map(library.projects.map((p) => [p.id, p])), [library.projects]);
  const allTags = useMemo(() => {
    const tags = new Map<string, string>();
    for (const capture of library.captures) for (const tag of capture.tags) tags.set(tag.toLowerCase(), tag);
    return [...tags.values()].sort((a, b) => a.localeCompare(b));
  }, [library.captures]);

  const currentProject = info.projectKey
    ? library.projects.find((p) => p.fileKey === info.projectKey) ?? null
    : null;

  const groups = useMemo(() => {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const lowerTags = tagFilter.map((t) => t.toLowerCase());
    const byProject = new Map<string, Capture[]>();
    const totals = new Map<string, number>();
    for (const capture of library.captures) {
      totals.set(capture.projectId, (totals.get(capture.projectId) ?? 0) + 1);
      const tagsOk = lowerTags.every((tag) => capture.tags.some((t) => t.toLowerCase() === tag));
      if (!tagsOk || !matches(capture, projectsById.get(capture.projectId), terms)) continue;
      const list = byProject.get(capture.projectId) ?? [];
      list.push(capture);
      byProject.set(capture.projectId, list);
    }
    const filtering = terms.length > 0 || lowerTags.length > 0;
    return library.projects
      .filter((p) => !filtering || byProject.has(p.id))
      .sort((a, b) => {
        if (a.id === currentProject?.id) return -1;
        if (b.id === currentProject?.id) return 1;
        return b.updatedAt - a.updatedAt;
      })
      .map((project) => ({ project, captures: byProject.get(project.id) ?? [], total: totals.get(project.id) ?? 0 }));
  }, [library.captures, library.projects, projectsById, query, tagFilter, currentProject?.id]);

  const newCapture = async () => {
    if (windowId === null) return;
    setCapturing(true);
    setNotice(null);
    try {
      await sendToBackground({ type: 'PANEL_NEW_CAPTURE', windowId });
    } catch (error) {
      setNotice({ tone: 'error', text: errorMessage(error) });
    } finally {
      setCapturing(false);
    }
  };

  if (view === 'settings') {
    return (
      <div className="dp-app">
        <AppHeader onSettings={() => setView('library')} settingsActive />
        <SettingsView onBack={() => setView('library')} />
      </div>
    );
  }

  const filtering = query.trim() !== '' || tagFilter.length > 0;

  return (
    <div className="dp-app">
      <AppHeader onSettings={() => setView('settings')} />

      <section className="dp-current" aria-label="Current tab">
        {info.supported ? (
          <>
            <div className="dp-current-text">
              <span className="dp-eyebrow">This tab</span>
              <strong>{currentProject?.name ?? 'Figma file'}</strong>
              {info.overlay && info.overlay.mode !== 'closed' ? (
                <span className="dp-muted"> · overlay {info.overlay.mode === 'annotate' ? 'drawing' : info.overlay.mode}</span>
              ) : null}
            </div>
            <button type="button" className="dp-btn is-primary" disabled={capturing} onClick={() => void newCapture()}>
              <Camera size={15} aria-hidden="true" /> {capturing ? 'Capturing…' : 'New capture'}
            </button>
          </>
        ) : (
          <p className="dp-muted dp-hint">
            {info.url && !info.supported
              ? 'This tab is not a Figma design file.'
              : `Open a Figma design, then click the extension icon (or press ${DEFAULT_SHORTCUTS.activate}) to capture the view and start drawing.`}
          </p>
        )}
      </section>

      {notice ? (
        <InlineMessage tone={notice.tone} onDismiss={() => setNotice(null)}>
          {notice.text}
        </InlineMessage>
      ) : null}

      <div className="dp-search">
        <Search size={15} aria-hidden="true" />
        <input
          type="search"
          value={query}
          placeholder="Search titles, notes, labels…"
          aria-label="Search captures"
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {allTags.length > 0 ? (
        <div className="dp-filter" role="group" aria-label="Filter by label">
          {allTags.map((tag) => {
            const active = tagFilter.some((t) => t.toLowerCase() === tag.toLowerCase());
            return (
              <button
                key={tag}
                type="button"
                className={`dp-chip ${active ? 'is-active' : ''}`}
                aria-pressed={active}
                onClick={() =>
                  setTagFilter((current) =>
                    active ? current.filter((t) => t.toLowerCase() !== tag.toLowerCase()) : [...current, tag],
                  )
                }
              >
                {tag}
              </button>
            );
          })}
          {tagFilter.length > 0 ? (
            <button type="button" className="dp-chip is-clear" onClick={() => setTagFilter([])}>
              <X size={12} aria-hidden="true" /> Clear
            </button>
          ) : null}
        </div>
      ) : null}

      <main className="dp-library">
        {library.error ? <InlineMessage tone="error">Could not load notes: {library.error}</InlineMessage> : null}
        {!library.loading && library.captures.length === 0 && library.projects.length === 0 ? (
          <div className="dp-empty">
            <p>
              <strong>No captures yet.</strong>
            </p>
            <ol>
              <li>Open a Figma design in this window.</li>
              <li>Click the Design Overlay Notes icon in the toolbar (or press {DEFAULT_SHORTCUTS.activate}).</li>
              <li>Draw and write over the design. Notes save automatically.</li>
            </ol>
          </div>
        ) : null}
        {!library.loading && filtering && groups.length === 0 ? <p className="dp-empty-small">Nothing matches.</p> : null}
        {groups.map(({ project, captures, total }) => (
          <ProjectSection
            key={project.id}
            project={project}
            captures={captures}
            totalCaptures={total}
            isCurrent={project.id === currentProject?.id}
            windowId={windowId}
            knownTags={allTags}
            onPageCaptureId={info.overlay?.mode !== 'closed' ? (info.overlay?.captureId ?? null) : null}
          />
        ))}
      </main>

      <footer className="dp-footer">
        <Lock size={12} aria-hidden="true" /> Stored only in this browser profile. Nothing leaves this computer.
      </footer>
    </div>
  );
}

function AppHeader({ onSettings, settingsActive }: { onSettings: () => void; settingsActive?: boolean }) {
  return (
    <header className="dp-header">
      <div className="dp-brand">
        <img src="/icons/icon-32.png" alt="" width={20} height={20} />
        <h1>Design Overlay Notes</h1>
      </div>
      <button
        type="button"
        className={`dp-icon-btn ${settingsActive ? 'is-active' : ''}`}
        aria-label="Settings, backup and privacy"
        title="Settings, backup and privacy"
        onClick={onSettings}
      >
        <Settings size={17} aria-hidden="true" />
      </button>
    </header>
  );
}
