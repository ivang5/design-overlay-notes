import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, Download, HardDrive, Keyboard, LocateFixed, ShieldCheck, Trash2, Upload } from 'lucide-react';
import { getStorageUsage, type StorageUsage } from '../../database/repository';
import { getSettings, updateSettings } from '../../database/settings';
import { FIGMA_ORIGINS, hasFigmaAccess } from '../../shared/figma-access';
import { backupFileName, createBackupArchive } from '../../export/backup-export';
import { importBackupFile } from '../../export/backup-import';
import { downloadBlob } from '../../export/png-export';
import { broadcastDataChange, errorMessage } from '../../shared/messages';
import { wipeEverything } from '../actions';
import { ConfirmAction, InlineMessage, formatBytes } from './common';

type Message = { tone: 'info' | 'error' | 'ok'; text: string } | null;

const DRAWING_KEYS: readonly (readonly [string, string])[] = [
  ['V', 'Select'],
  ['P', 'Pen'],
  ['H', 'Highlighter'],
  ['A', 'Arrow'],
  ['R', 'Rectangle'],
  ['O', 'Ellipse'],
  ['T', 'Text'],
  ['S', 'Sticky note'],
  ['E', 'Eraser'],
  ['Ctrl/⌘+Z', 'Undo'],
  ['Ctrl/⌘+Shift+Z', 'Redo'],
  ['Delete', 'Delete selected'],
  ['Esc', 'Stop drawing'],
];

export function SettingsView({ onBack }: { onBack: () => void }) {
  const [usage, setUsage] = useState<StorageUsage | null>(null);
  const [commands, setCommands] = useState<chrome.commands.Command[]>([]);
  const [message, setMessage] = useState<Message>(null);
  const [busy, setBusy] = useState(false);
  const [followView, setFollowView] = useState<boolean | null>(null);
  const [figmaAccess, setFigmaAccess] = useState<boolean | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const refresh = useCallback(() => {
    void getStorageUsage().then(setUsage);
  }, []);

  useEffect(() => {
    void getSettings().then((s) => setFollowView(s.followView));
    void hasFigmaAccess().then(setFigmaAccess);
  }, []);

  useEffect(() => {
    refresh();
    chrome.commands
      .getAll()
      .then(setCommands)
      .catch(() => setCommands([]));
  }, [refresh]);

  const run = async (action: () => Promise<string | void>) => {
    setBusy(true);
    setMessage(null);
    try {
      const result = await action();
      if (result) setMessage({ tone: 'ok', text: result });
    } catch (error) {
      setMessage({ tone: 'error', text: errorMessage(error) });
    } finally {
      setBusy(false);
      refresh();
    }
  };

  return (
    <div className="dp-settings">
      <div className="dp-settings-header">
        <button type="button" className="dp-btn is-ghost" onClick={onBack}>
          <ArrowLeft size={15} aria-hidden="true" /> Back to notes
        </button>
      </div>

      {message ? (
        <InlineMessage tone={message.tone} onDismiss={() => setMessage(null)}>
          {message.text}
        </InlineMessage>
      ) : null}

      <section className="dp-panel-section">
        <h2>
          <ShieldCheck size={16} aria-hidden="true" /> Privacy
        </h2>
        <ul className="dp-list">
          <li>Notes and screenshots are stored only in this Chrome profile on this computer (extension IndexedDB).</li>
          <li>Nothing is sent to any server, nothing is written to Figma, and there is no account, sync or analytics.</li>
          <li>
            Local storage is <strong>not encrypted</strong>. Anyone with access to this OS account, browser profile, device
            backups or admin tools may be able to read it. Follow your company's policy for storing design screenshots.
          </li>
          <li>Uninstalling the extension deletes its data. Export a backup first.</li>
        </ul>
      </section>

      <section className="dp-panel-section">
        <h2>
          <LocateFixed size={16} aria-hidden="true" /> Figma view
        </h2>
        <label className="dp-check">
          <input
            type="checkbox"
            checked={followView ?? true}
            disabled={followView === null}
            onChange={(e) => {
              const next = e.target.checked;
              setFollowView(next);
              void updateSettings({ followView: next });
            }}
          />
          <span>
            <strong>Keep notes attached to the design</strong> when you scroll or zoom Figma. The extension compares
            temporary screenshots of the tab with the capture to find where your notes belong; they are processed in
            memory and never stored.
          </span>
        </label>
        <label className="dp-check">
          <input
            type="checkbox"
            checked={figmaAccess ?? false}
            disabled={figmaAccess === null}
            onChange={(e) => {
              const next = e.target.checked;
              void run(async () => {
                // Must run inside the click (user gesture) for Chrome to show its prompt.
                const ok = next
                  ? await chrome.permissions.request({ origins: FIGMA_ORIGINS })
                  : await chrome.permissions.remove({ origins: FIGMA_ORIGINS });
                setFigmaAccess(await hasFigmaAccess());
                if (next && !ok) return 'Chrome did not grant access. You can keep clicking the icon on each Figma tab.';
              });
            }}
          />
          <span>
            <strong>Work on Figma tabs without a click.</strong> Lets “Open in Figma” show notes automatically and
            notes-manager actions reach Figma tabs where you have not clicked the extension icon. Chrome will ask to
            allow access to www.figma.com.
          </span>
        </label>
      </section>

      <section className="dp-panel-section">
        <h2>
          <HardDrive size={16} aria-hidden="true" /> Storage
        </h2>
        {usage ? (
          <dl className="dp-facts">
            <dt>Projects</dt>
            <dd>{usage.projectCount}</dd>
            <dt>Captures</dt>
            <dd>{usage.captureCount}</dd>
            <dt>Used</dt>
            <dd>
              {formatBytes(usage.usageBytes)}
              {usage.quotaBytes ? ` of ${formatBytes(usage.quotaBytes)} available` : ''}
            </dd>
            <dt>Protected from eviction</dt>
            <dd>{usage.persisted === null ? 'unknown' : usage.persisted ? 'yes' : 'no'}</dd>
          </dl>
        ) : (
          <p className="dp-muted">Loading…</p>
        )}
        {usage && usage.persisted === false ? (
          <button
            type="button"
            className="dp-btn"
            disabled={busy}
            onClick={() =>
              void run(async () =>
                (await navigator.storage.persist())
                  ? 'Chrome will now keep this data even when disk space runs low.'
                  : 'Chrome declined the request. Data is still stored, but may be evicted under storage pressure.',
              )
            }
          >
            Ask Chrome to keep data under storage pressure
          </button>
        ) : null}
      </section>

      <section className="dp-panel-section">
        <h2>
          <Download size={16} aria-hidden="true" /> Backup &amp; restore
        </h2>
        <p className="dp-muted">
          A backup is a .zip with all projects, captures, screenshots and notes. Use it to move notes to another computer
          or Chrome profile. The file is not encrypted.
        </p>
        <div className="dp-row">
          <button
            type="button"
            className="dp-btn is-primary"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const archive = await createBackupArchive(chrome.runtime.getManifest().version);
                downloadBlob(archive, backupFileName());
                return `Backup created (${formatBytes(archive.size)}).`;
              })
            }
          >
            <Download size={15} aria-hidden="true" /> Export backup
          </button>
          <button type="button" className="dp-btn" disabled={busy} onClick={() => fileInput.current?.click()}>
            <Upload size={15} aria-hidden="true" /> Restore from backup
          </button>
          <input
            ref={fileInput}
            type="file"
            accept=".zip,application/zip"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (!file) return;
              void run(async () => {
                const report = await importBackupFile(file);
                broadcastDataChange({ scope: 'projects' });
                return (
                  `Restored ${report.capturesAdded} capture(s) with ${report.annotationsAdded} mark(s)` +
                  (report.capturesSkipped ? `, skipped ${report.capturesSkipped} already present` : '') +
                  '.'
                );
              });
            }}
          />
        </div>
      </section>

      <section className="dp-panel-section">
        <h2>
          <Keyboard size={16} aria-hidden="true" /> Keyboard shortcuts
        </h2>
        <ul className="dp-shortcuts">
          {commands.map((command) => (
            <li key={command.name}>
              <span>{command.name === '_execute_action' ? 'Open the toolbar / start or stop drawing' : command.description}</span>
              {command.shortcut ? <kbd>{command.shortcut}</kbd> : <span className="dp-muted">not set</span>}
            </li>
          ))}
        </ul>
        <h3 className="dp-subheading">While drawing</h3>
        <ul className="dp-keygrid">
          {DRAWING_KEYS.map(([key, label]) => (
            <li key={key}>
              <kbd>{key}</kbd>
              <span>{label}</span>
            </li>
          ))}
        </ul>
        <button
          type="button"
          className="dp-btn is-fit"
          onClick={() => void chrome.tabs.create({ url: 'chrome://extensions/shortcuts' })}
        >
          Change shortcuts
        </button>
      </section>

      <section className="dp-panel-section is-danger">
        <h2>
          <Trash2 size={16} aria-hidden="true" /> Delete all local data
        </h2>
        <p className="dp-muted">Removes every project, capture, screenshot, note and preference from this profile.</p>
        <ConfirmAction
          prompt="Delete everything? This cannot be undone."
          confirmLabel="Delete everything"
          onConfirm={() => void run(async () => {
            await wipeEverything();
            return 'All local data was deleted.';
          })}
        >
          {(ask) => (
            <button type="button" className="dp-btn is-danger is-fit" disabled={busy} onClick={ask}>
              Delete all local data
            </button>
          )}
        </ConfirmAction>
      </section>
    </div>
  );
}
