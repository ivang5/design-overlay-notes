import { useEffect, useState } from 'react';
import { Copy, ExternalLink, ImageDown, Monitor, NotebookPen, Trash2 } from 'lucide-react';
import { errorMessage, sendToBackground } from '../../shared/messages';
import type { Capture } from '../../shared/schemas';
import { copyCapture, exportCapturePng, openReview, removeCapture, saveCaptureMeta } from '../actions';
import { forgetThumbnail, useThumbnail } from '../hooks';
import { ConfirmAction, IconButton, InlineMessage, TagEditor, formatDateTime } from './common';

interface Props {
  capture: Capture;
  windowId: number | null;
  knownTags: string[];
  isOnPage: boolean;
}

export function CaptureCard({ capture, windowId, knownTags, isOnPage }: Props) {
  const thumbnail = useThumbnail(capture.id);
  const [title, setTitle] = useState(capture.title);
  const [description, setDescription] = useState(capture.description);
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'error' | 'warn' | 'ok'; text: string } | null>(null);
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
          <span>{formatDateTime(capture.createdAt)}</span>
          <span aria-hidden="true">·</span>
          <span>
            {noteCount} {noteCount === 1 ? 'mark' : 'marks'}
          </span>
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
          <IconButton label="Open for review / editing" onClick={() => void run(() => openReview(capture.id))}>
            <ExternalLink size={15} aria-hidden="true" />
          </IconButton>
          <IconButton label="Show over the current Figma tab" disabled={busy} onClick={() => void showOnPage(false)}>
            <Monitor size={15} aria-hidden="true" />
          </IconButton>
          <IconButton label="Export annotated PNG" disabled={busy} onClick={() => void run(() => exportCapturePng(capture))}>
            <ImageDown size={15} aria-hidden="true" />
          </IconButton>
          <IconButton label="Duplicate" disabled={busy} onClick={() => void run(async () => void (await copyCapture(capture.id)))}>
            <Copy size={15} aria-hidden="true" />
          </IconButton>
          <IconButton label={expanded ? 'Hide details' : 'Description & labels'} onClick={() => setExpanded((v) => !v)}>
            <NotebookPen size={15} aria-hidden="true" />
          </IconButton>
          <span className="dp-spacer" />
          <ConfirmAction
            prompt="Delete capture?"
            onConfirm={() =>
              void run(async () => {
                await removeCapture(capture.id);
                forgetThumbnail(capture.id);
              })
            }
          >
            {(ask) => (
              <IconButton label="Delete capture" tone="danger" onClick={ask}>
                <Trash2 size={15} aria-hidden="true" />
              </IconButton>
            )}
          </ConfirmAction>
        </div>

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
                    <a href={capture.pageUrl} target="_blank" rel="noreferrer noopener">
                      Open in Figma
                    </a>
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
