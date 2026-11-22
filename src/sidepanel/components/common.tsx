import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { MoreHorizontal, X, type LucideIcon } from 'lucide-react';
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
    <ConfirmPrompt
      prompt={prompt}
      confirmLabel={confirmLabel}
      onConfirm={() => {
        setAsking(false);
        onConfirm();
      }}
      onCancel={() => setAsking(false)}
    />
  );
}

/** Inline confirmation: a full row in wrapping flex containers, buttons side by side below the prompt. */
export function ConfirmPrompt({
  prompt,
  confirmLabel = 'Delete',
  onConfirm,
  onCancel,
}: {
  prompt: string;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  useEffect(() => confirmRef.current?.focus(), []);
  return (
    <div
      className="dp-confirm"
      role="alertdialog"
      aria-label={prompt}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onCancel();
      }}
    >
      <p className="dp-confirm-prompt">{prompt}</p>
      <div className="dp-confirm-actions">
        <button ref={confirmRef} type="button" className="dp-btn is-danger is-small" onClick={onConfirm}>
          {confirmLabel}
        </button>
        <button type="button" className="dp-btn is-small" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

export interface MenuItem {
  label: string;
  icon: LucideIcon;
  onSelect: () => void;
  disabled?: boolean;
  tone?: 'danger';
}

/**
 * "⋯" button with a dropdown of secondary actions. Keyboard: Enter/Space or
 * ↓ opens, ↑/↓ move, Enter selects, Esc closes and returns focus.
 */
export function ActionMenu({ label, items }: { label: string; items: MenuItem[] }) {
  const [open, setOpen] = useState(false);
  const [upward, setUpward] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) buttonRef.current?.focus();
  };

  useLayoutEffect(() => {
    if (!open || !menuRef.current) return;
    // Open upwards when there is no room below (bottom of the panel).
    const rect = menuRef.current.getBoundingClientRect();
    setUpward(rect.bottom > window.innerHeight - 8 && rect.top - rect.height > 40);
    menuRef.current.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!menuRef.current?.contains(target) && !buttonRef.current?.contains(target)) close(false);
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [open]);

  const moveFocus = (delta: number) => {
    const buttons = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    buttons[(index + delta + buttons.length) % buttons.length]?.focus();
  };

  return (
    <span className="dp-menu-anchor">
      <button
        ref={buttonRef}
        type="button"
        className={`dp-icon-btn ${open ? 'is-active' : ''}`}
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => {
          setUpward(false);
          setOpen((v) => !v);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && !open) {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        <MoreHorizontal size={16} aria-hidden="true" />
      </button>
      {open ? (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          className={`dp-menu ${upward ? 'is-up' : ''}`}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              close(true);
            } else if (e.key === 'ArrowDown') {
              e.preventDefault();
              moveFocus(1);
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              moveFocus(-1);
            } else if (e.key === 'Tab') {
              close(false);
            }
          }}
        >
          {items.map(({ label: itemLabel, icon: Icon, onSelect, disabled, tone }) => (
            <button
              key={itemLabel}
              type="button"
              role="menuitem"
              className={`dp-menu-item ${tone === 'danger' ? 'is-danger' : ''}`}
              disabled={disabled}
              onClick={() => {
                close(true);
                onSelect();
              }}
            >
              <Icon size={15} aria-hidden="true" />
              <span>{itemLabel}</span>
            </button>
          ))}
        </div>
      ) : null}
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

/**
 * Inline "new project" form. With `fileName` (a Figma file is open in this
 * tab), offers to save that file's new captures in the new project.
 */
export function NewProjectForm({
  fileName,
  onCreate,
  onCancel,
}: {
  fileName: string | null;
  onCreate: (name: string, useForTab: boolean) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState('');
  const [useForTab, setUseForTab] = useState(true);
  return (
    <form
      className="dp-new-project"
      aria-label="New project"
      onSubmit={(e) => {
        e.preventDefault();
        const trimmed = name.trim();
        if (trimmed) onCreate(trimmed, fileName !== null && useForTab);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onCancel();
      }}
    >
      <input
        className="dp-input"
        autoFocus
        value={name}
        maxLength={300}
        placeholder="Project name, e.g. Checkout redesign"
        aria-label="Project name"
        onChange={(e) => setName(e.target.value)}
      />
      {fileName !== null ? (
        <label className="dp-check">
          <input type="checkbox" checked={useForTab} onChange={(e) => setUseForTab(e.target.checked)} />
          <span>Save new captures from “{fileName}” here</span>
        </label>
      ) : null}
      <div className="dp-row">
        <button type="submit" className="dp-btn is-primary is-small" disabled={!name.trim()}>
          Create project
        </button>
        <button type="button" className="dp-btn is-small" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
