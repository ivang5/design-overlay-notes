import { useId, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { LABEL_SUGGESTIONS } from '../../shared/schemas';

export function IconButton({
  label,
  onClick,
  children,
  disabled,
  tone,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
  disabled?: boolean;
  tone?: 'danger';
}) {
  return (
    <button
      type="button"
      className={`dp-icon-btn ${tone === 'danger' ? 'is-danger' : ''}`}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/** Two-step inline confirmation (no blocking browser dialogs in the side panel). */
export function ConfirmAction({
  prompt,
  confirmLabel = 'Delete',
  onConfirm,
  children,
}: {
  prompt: string;
  confirmLabel?: string;
  onConfirm: () => void;
  children: (ask: () => void) => ReactNode;
}) {
  const [asking, setAsking] = useState(false);
  if (!asking) return <>{children(() => setAsking(true))}</>;
  return (
    <span className="dp-confirm" role="alertdialog" aria-label={prompt}>
      <span>{prompt}</span>
      <button
        type="button"
        className="dp-btn is-danger is-small"
        onClick={() => {
          setAsking(false);
          onConfirm();
        }}
      >
        {confirmLabel}
      </button>
      <button type="button" className="dp-btn is-small" onClick={() => setAsking(false)}>
        Cancel
      </button>
    </span>
  );
}

export function TagEditor({
  tags,
  knownTags,
  onChange,
}: {
  tags: string[];
  knownTags: string[];
  onChange: (tags: string[]) => void;
}) {
  const [draft, setDraft] = useState('');
  const listId = useId();
  const suggestions = Array.from(new Set([...LABEL_SUGGESTIONS, ...knownTags])).filter(
    (t) => !tags.some((existing) => existing.toLowerCase() === t.toLowerCase()),
  );

  const add = (raw: string) => {
    const tag = raw.trim();
    setDraft('');
    if (!tag || tags.some((t) => t.toLowerCase() === tag.toLowerCase())) return;
    onChange([...tags, tag]);
  };

  return (
    <div className="dp-tag-editor">
      {tags.map((tag) => (
        <span key={tag} className="dp-tag">
          {tag}
          <button
            type="button"
            aria-label={`Remove label ${tag}`}
            onClick={() => onChange(tags.filter((t) => t !== tag))}
          >
            <X size={11} aria-hidden="true" />
          </button>
        </span>
      ))}
      <input
        className="dp-tag-input"
        list={listId}
        value={draft}
        placeholder={tags.length ? 'Add label…' : 'Add a label (e.g. Question)'}
        onChange={(e) => {
          const value = e.target.value;
          if (value.endsWith(',')) add(value.slice(0, -1));
          else setDraft(value);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            add(draft);
          } else if (e.key === 'Backspace' && draft === '' && tags.length) {
            onChange(tags.slice(0, -1));
          }
        }}
        onBlur={() => draft && add(draft)}
      />
      <datalist id={listId}>
        {suggestions.map((s) => (
          <option key={s} value={s} />
        ))}
      </datalist>
    </div>
  );
}

export function InlineMessage({
  tone,
  children,
  onDismiss,
}: {
  tone: 'info' | 'error' | 'warn' | 'ok';
  children: ReactNode;
  onDismiss?: () => void;
}) {
  return (
    <div className={`dp-message is-${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      <div className="dp-message-body">{children}</div>
      {onDismiss ? (
        <button type="button" className="dp-icon-btn" aria-label="Dismiss" title="Dismiss" onClick={onDismiss}>
          <X size={14} aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}

export function formatBytes(bytes: number | null): string {
  if (bytes === null) return 'unknown';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

export function formatDateTime(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(timestamp));
}
