import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, Download, HardDrive, Keyboard, ShieldCheck, Trash2, Upload } from 'lucide-react';
import { getStorageUsage, type StorageUsage } from '../../database/repository';
import { backupFileName, createBackupArchive } from '../../export/backup-export';
import { importBackupFile } from '../../export/backup-import';
import { downloadBlob } from '../../export/png-export';
import { broadcastDataChange, errorMessage } from '../../shared/messages';
import { wipeEverything } from '../actions';
import { ConfirmAction, InlineMessage, formatBytes } from './common';

type Message = { tone: 'info' | 'error' | 'ok'; text: string } | null;

export function SettingsView({ onBack }: { onBack: () => void }) {
  const [usage, setUsage] = useState<StorageUsage | null>(null);
  const [commands, setCommands] = useState<chrome.commands.Command[]>([]);
  const [message, setMessage] = useState<Message>(null);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const refresh = useCallback(() => {
    void getStorageUsage().then(setUsage);
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
            <Upload size={15} aria-hidden="true" /> Restore from backup…
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
        <dl className="dp-facts">
          {commands.map((command) => (
            <div key={command.name} className="dp-fact-row">
              <dt>{command.name === '_execute_action' ? 'Start annotating / toggle drawing' : command.description}</dt>
              <dd>{command.shortcut || <span className="dp-muted">not set</span>}</dd>
            </div>
          ))}
        </dl>
        <p className="dp-muted">
          While drawing: V select, P pen, H highlighter, A arrow, R rectangle, O ellipse, T text, S sticky note, E eraser,
          Ctrl/⌘+Z undo, Esc to stop drawing.
        </p>
        <button
          type="button"
          className="dp-btn"
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
            <button type="button" className="dp-btn is-danger" disabled={busy} onClick={ask}>
              Delete all local data…
            </button>
          )}
        </ConfirmAction>
      </section>
    </div>
  );
}
