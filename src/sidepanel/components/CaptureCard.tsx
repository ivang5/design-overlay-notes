import { useEffect, useState } from 'react';
import { ClipboardCopy, Copy, ExternalLink, FolderInput, ImageDown, LocateFixed, Monitor, NotebookPen, Trash2 } from 'lucide-react';
import { errorMessage, sendToBackground } from '../../shared/messages';
import type { Capture, Project } from '../../shared/schemas';
import { copyCapture, copyCapturePng, exportCapturePng, moveCaptureTo, openReview, removeCapture, saveCaptureMeta } from '../actions';
import { forgetThumbnail, useThumbnail } from '../hooks';
import { ActionMenu, ConfirmPrompt, IconButton, InlineMessage, TagEditor, formatDateTime } from './common';

interface Props {
  capture: Capture;
  projects: Project[];
  windowId: number | null;
  knownTags: string[];
  isOnPage: boolean;
}

export function CaptureCard({ capture, projects, windowId, knownTags, isOnPage }: Props) {
  const thumbnail = useThumbnail(capture.id);
  const [title, setTitle] = useState(capture.title);
  const [description, setDescription] = useState(capture.description);
  const [expanded, setExpanded] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [moving, setMoving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'error' | 'warn' | 'ok' | 'info'; text: string } | null>(null);
  const [mismatch, setMismatch] = useState<string[] | null>(null);

  useEffect(() => setTitle(capture.title), [capture.title]);
  useEffect(() => setDescription(capture.description), [capture.description]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setMessage(null);
    try {
      await action();
    } catch (error) {
      setMessage({ tone: 'error', text: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  };

  const commitTitle = () => {
    const next = title.trim();
    if (!next) {
      setTitle(capture.title);
      return;
    }
    if (next !== capture.title) void run(async () => void (await saveCaptureMeta(capture.id, { title: next })));
  };

  const showOnPage = (force: boolean) =>
    run(async () => {
      if (windowId === null) throw new Error('Window not found');
      setMismatch(null);
      const result = await sendToBackground({ type: 'PANEL_SHOW_ON_PAGE', windowId, captureId: capture.id, force });
      if (result.status === 'mismatch') setMismatch(result.reasons);
    });

  const openInFigma = () =>
    run(async () => {
      if (windowId === null) throw new Error('Window not found');
      const result = await sendToBackground({ type: 'PANEL_OPEN_IN_FIGMA', windowId, captureId: capture.id });
      if (result.status === 'needs-click') {
        setMessage({
          tone: 'info',
          text: 'Click the Design Overlay Notes icon on the Figma tab to show these notes there. (Settings → “Work on Figma tabs without a click” does this automatically.)',
        });
      }
    });

  const noteCount = capture.annotationCount;

  return (
    <article className={`dp-card ${isOnPage ? 'is-on-page' : ''}`} aria-label={capture.title}>
      <button
        type="button"
        className="dp-thumb"
        title="Open capture for review and editing"
        onClick={() => void run(() => openReview(capture.id))}
      >
        {thumbnail ? <img src={thumbnail} alt="" draggable={false} /> : <span className="dp-thumb-empty" />}
        {isOnPage ? <span className="dp-badge">On page</span> : null}
      </button>

      <div className="dp-card-body">
        <input
          className="dp-title-input"
          value={title}
          aria-label="Capture title"
          onChange={(e) => setTitle(e.target.value)}
          onBlur={commitTitle}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
            if (e.key === 'Escape') {
              setTitle(capture.title);
              e.currentTarget.blur();
            }
          }}
        />
        <div className="dp-meta">
          {/* The default title already is the date; don't repeat it. */}
          {capture.title !== formatDateTime(capture.createdAt) ? (
            <>
              <span>{formatDateTime(capture.createdAt)}</span>
              <span aria-hidden="true">·</span>
            </>
          ) : null}
          <span>
            {noteCount} {noteCount === 1 ? 'mark' : 'marks'}
          </span>
          {capture.figmaZoom ? (
            <>
              <span aria-hidden="true">·</span>
              <span title="Figma zoom when captured">{Math.round(capture.figmaZoom * 100)}%</span>
            </>
          ) : null}
        </div>
        {capture.tags.length > 0 && !expanded ? (
          <div className="dp-tags">
            {capture.tags.map((tag) => (
              <span key={tag} className="dp-tag is-static">
                {tag}
              </span>
            ))}
          </div>
        ) : null}
        {capture.description && !expanded ? <p className="dp-description">{capture.description}</p> : null}

        <div className="dp-actions">
          <IconButton label="Open in Figma and show these notes" disabled={busy || !capture.pageUrl} onClick={() => void openInFigma()}>
            <LocateFixed size={15} aria-hidden="true" />
          </IconButton>
          <IconButton label="Open for review / editing" onClick={() => void run(() => openReview(capture.id))}>
            <ExternalLink size={15} aria-hidden="true" />
          </IconButton>
          <IconButton
            label="Copy annotated image to the clipboard"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await copyCapturePng(capture);
                setMessage({ tone: 'ok', text: 'Annotated image copied to the clipboard.' });
              })
            }
          >
            <ClipboardCopy size={15} aria-hidden="true" />
          </IconButton>
          <span className="dp-spacer" />
          <ActionMenu
            label="More actions"
            items={[
              { label: 'Show over the current Figma tab', icon: Monitor, disabled: busy, onSelect: () => void showOnPage(false) },
              { label: 'Export annotated PNG', icon: ImageDown, disabled: busy, onSelect: () => void run(() => exportCapturePng(capture)) },
              { label: 'Duplicate', icon: Copy, disabled: busy, onSelect: () => void run(async () => void (await copyCapture(capture.id))) },
              { label: 'Move to project…', icon: FolderInput, disabled: busy, onSelect: () => setMoving(true) },
              {
                label: expanded ? 'Hide description & labels' : 'Description & labels',
                icon: NotebookPen,
                onSelect: () => setExpanded((v) => !v),
              },
              { label: 'Delete capture…', icon: Trash2, tone: 'danger', onSelect: () => setConfirmDelete(true) },
            ]}
          />
        </div>
        {moving ? (
          <MoveToProject
            projects={projects.filter((p) => p.id !== capture.projectId)}
            onCancel={() => setMoving(false)}
            onMove={(projectId) => {
              setMoving(false);
              void run(() => moveCaptureTo(capture.id, projectId));
            }}
          />
        ) : null}
        {confirmDelete ? (
          <ConfirmPrompt
            prompt="Delete this capture and its notes?"
            onCancel={() => setConfirmDelete(false)}
            onConfirm={() => {
              setConfirmDelete(false);
              void run(async () => {
                await removeCapture(capture.id);
                forgetThumbnail(capture.id);
              });
            }}
          />
        ) : null}

        {expanded ? (
          <div className="dp-details">
            <label className="dp-field">
              <span>Description</span>
              <textarea
                value={description}
                rows={3}
                placeholder="What is this capture about?"
                onChange={(e) => setDescription(e.target.value)}
                onBlur={() => {
                  if (description !== capture.description) {
                    void run(async () => void (await saveCaptureMeta(capture.id, { description })));
                  }
                }}
              />
            </label>
            <div className="dp-field">
              <span>Labels</span>
              <TagEditor
                tags={capture.tags}
                knownTags={knownTags}
                onChange={(tags) => void run(async () => void (await saveCaptureMeta(capture.id, { tags })))}
              />
            </div>
            <dl className="dp-facts">
              <dt>Viewport</dt>
              <dd>
                {Math.round(capture.viewportCssWidth)}×{Math.round(capture.viewportCssHeight)} CSS px @{' '}
                {Math.round(capture.devicePixelRatio * 100) / 100}x
              </dd>
              <dt>Screenshot</dt>
              <dd>
                {capture.screenshotPixelWidth}×{capture.screenshotPixelHeight} px
              </dd>
              {capture.pageUrl ? (
                <>
                  <dt>Figma URL</dt>
                  <dd>
                    <button type="button" className="dp-link-btn" onClick={() => void openInFigma()}>
                      Open in Figma
                    </button>
                  </dd>
                </>
              ) : null}
            </dl>
          </div>
        ) : null}

        {mismatch ? (
          <InlineMessage tone="warn" onDismiss={() => setMismatch(null)}>
            <p>The current tab's view differs from this capture:</p>
            <ul>
              {mismatch.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
            <p>Marks may point at the wrong place.</p>
            <div className="dp-row">
              <button type="button" className="dp-btn is-small" onClick={() => void showOnPage(true)}>
                Show anyway
              </button>
              <button type="button" className="dp-btn is-small" onClick={() => void run(() => openReview(capture.id))}>
                Open as image instead
              </button>
            </div>
          </InlineMessage>
        ) : null}
        {message ? (
          <InlineMessage tone={message.tone} onDismiss={() => setMessage(null)}>
            {message.text}
          </InlineMessage>
        ) : null}
      </div>
    </article>
  );
}

/** Inline picker: move a capture to another project. */
function MoveToProject({
  projects,
  onMove,
  onCancel,
}: {
  projects: Project[];
  onMove: (projectId: string) => void;
  onCancel: () => void;
}) {
  const sorted = [...projects].sort((a, b) => a.name.localeCompare(b.name));
  const [projectId, setProjectId] = useState(sorted[0]?.id ?? '');
  if (sorted.length === 0) {
    return (
      <InlineMessage tone="info" onDismiss={onCancel}>
        There is no other project yet. Create one with “New project” above the list.
      </InlineMessage>
    );
  }
  return (
    <form
      className="dp-move"
      aria-label="Move to project"
      onSubmit={(e) => {
        e.preventDefault();
        if (projectId) onMove(projectId);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onCancel();
      }}
    >
      <label className="dp-field">
        <span>Move to project</span>
        <select autoFocus value={projectId} onChange={(e) => setProjectId(e.target.value)}>
          {sorted.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <div className="dp-row">
        <button type="submit" className="dp-btn is-primary is-small">
          Move
        </button>
        <button type="button" className="dp-btn is-small" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
