// Browser launchers for the e2e smoke test.
//
// 1. Default: Playwright's Chromium (Chrome for Testing) with --load-extension.
//    Set CHROMIUM_PATH to reuse an already-downloaded Chromium binary.
// 2. CHROME_PATH=/path/to/google-chrome: your real, branded Chrome. Branded Chrome
//    (137+) ignores --load-extension, so we start it with a DevTools pipe,
//    install the unpacked build via CDP Extensions.loadUnpacked (requires
//    --enable-unsafe-extension-debugging) and attach Playwright over a port.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';

const WIDTH = 1280;
const HEIGHT = 800;
// Device pixel ratio / display scaling to test (e.g. E2E_DPR=1.25 or 2).
const DPR = Number(process.env.E2E_DPR ?? 1);

export async function launchWithExtension(extensionPath) {
  if (process.env.CHROME_PATH) return launchBrandedChrome(process.env.CHROME_PATH, extensionPath);
  const userDataDir = mkdtempSync(join(tmpdir(), 'don-e2e-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: true,
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
    acceptDownloads: true,
    // Real display scaling (not emulation), so captureVisibleTab sees it too.
    viewport: null,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      `--window-size=${WIDTH},${HEIGHT}`,
      `--force-device-scale-factor=${DPR}`,
    ],
  });
  return {
    context,
    label: `Playwright Chromium, DPR ${DPR}`,
    async close() {
      await context.close();
      rmSync(userDataDir, { recursive: true, force: true });
    },
  };
}

async function launchBrandedChrome(executable, extensionPath) {
  const userDataDir = mkdtempSync(join(tmpdir(), 'don-e2e-chrome-'));
  const proc = spawn(
    executable,
    [
      '--headless',
      '--remote-debugging-pipe',
      '--remote-debugging-port=0',
      '--enable-unsafe-extension-debugging',
      `--user-data-dir=${userDataDir}`,
      `--window-size=${WIDTH},${HEIGHT}`,
      `--force-device-scale-factor=${DPR}`,
      '--no-first-run',
      '--no-default-browser-check',
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] },
  );

  // Minimal CDP client over the pipe (fd 3 = to Chrome, fd 4 = from Chrome).
  let nextId = 1;
  const pending = new Map();
  let buffer = '';
  proc.stdio[4].on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let index;
    while ((index = buffer.indexOf('\0')) >= 0) {
      const message = JSON.parse(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
      const entry = pending.get(message.id);
      if (!entry) continue;
      pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error.message));
      else entry.resolve(message.result);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      proc.stdio[3].write(`${JSON.stringify({ id, method, params })}\0`);
    });

  const portFile = join(userDataDir, 'DevToolsActivePort');
  for (let i = 0; i < 100 && !existsSync(portFile); i++) await new Promise((r) => setTimeout(r, 100));
  const port = readFileSync(portFile, 'utf8').split('\n')[0];
  await send('Extensions.loadUnpacked', { path: extensionPath });

  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context = browser.contexts()[0];
  return {
    context,
    label: `Chrome ${browser.version()}, DPR ${DPR}`,
    async close() {
      await browser.close().catch(() => undefined);
      proc.kill();
      await new Promise((r) => setTimeout(r, 300));
      rmSync(userDataDir, { recursive: true, force: true });
    },
  };
}
