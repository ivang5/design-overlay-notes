import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Pencil, Trash2 } from 'lucide-react';
import { errorMessage } from '../../shared/messages';
import type { Capture, Project } from '../../shared/schemas';
import { removeProject, saveProjectName } from '../actions';
import { CaptureCard } from './CaptureCard';
import { ActionMenu, ConfirmPrompt, InlineMessage } from './common';

interface Props {
  project: Project;
  captures: Capture[];
  totalCaptures: number;
  isCurrent: boolean;
  windowId: number | null;
  knownTags: string[];
  onPageCaptureId: string | null;
}

export function ProjectSection({
  project,
  captures,
  totalCaptures,
  isCurrent,
  windowId,
  knownTags,
  onPageCaptureId,
}: Props) {
  const [open, setOpen] = useState(true);
  const [renaming, setRenaming] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [name, setName] = useState(project.name);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setName(project.name), [project.name]);

  const commitName = () => {
    setRenaming(false);
    const next = name.trim();
    if (next && next !== project.name) {
      saveProjectName(project.id, next).catch((e: unknown) => setError(errorMessage(e)));
    } else {
      setName(project.name);
    }
  };

  return (
    <section className={`dp-project ${isCurrent ? 'is-current' : ''}`} aria-label={project.name}>
      <header className="dp-project-header">
        <button
          type="button"
          className="dp-icon-btn"
          aria-expanded={open}
          aria-label={open ? 'Collapse' : 'Expand'}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? <ChevronDown size={15} aria-hidden="true" /> : <ChevronRight size={15} aria-hidden="true" />}
        </button>
        {renaming ? (
          <input
            className="dp-project-input"
            value={name}
            autoFocus
            aria-label="Project name"
            onChange={(e) => setName(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitName();
              if (e.key === 'Escape') {
                setName(project.name);
                setRenaming(false);
              }
            }}
          />
        ) : (
          <h2 className="dp-project-name" title={project.name} onDoubleClick={() => setRenaming(true)}>
            {project.name}
          </h2>
        )}
        {isCurrent ? <span className="dp-pill">This tab</span> : null}
        <span className="dp-count">{totalCaptures}</span>
        <ActionMenu
          label="Project actions"
          items={[
            { label: 'Rename project', icon: Pencil, onSelect: () => setRenaming(true) },
            { label: 'Delete project…', icon: Trash2, tone: 'danger', onSelect: () => setConfirmDelete(true) },
          ]}
        />
        {confirmDelete ? (
          <ConfirmPrompt
            prompt={`Delete “${project.name}” and its ${totalCaptures} ${totalCaptures === 1 ? 'capture' : 'captures'}?`}
            onCancel={() => setConfirmDelete(false)}
            onConfirm={() => {
              setConfirmDelete(false);
              removeProject(project.id).catch((e: unknown) => setError(errorMessage(e)));
            }}
          />
        ) : null}
      </header>
      {error ? (
        <InlineMessage tone="error" onDismiss={() => setError(null)}>
          {error}
        </InlineMessage>
      ) : null}
      {open ? (
        <div className="dp-card-list">
          {captures.length === 0 ? <p className="dp-empty-small">No captures match.</p> : null}
          {captures.map((capture) => (
            <CaptureCard
              key={capture.id}
              capture={capture}
              windowId={windowId}
              knownTags={knownTags}
              isOnPage={capture.id === onPageCaptureId}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}
