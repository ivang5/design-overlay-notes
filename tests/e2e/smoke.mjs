// End-to-end smoke test: loads the e2e build of the extension (dist-e2e/) into
// Chromium, opens a local Figma-like fixture page and exercises the real flow.
//
//   npm run test:e2e                                   # Playwright's Chromium
//   CHROMIUM_PATH=/path/to/chrome-for-testing npm run test:e2e
//   CHROME_PATH=/usr/bin/google-chrome-stable npm run test:e2e   # your real Chrome
//
// See tests/e2e/launch.mjs for how each browser is started.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchWithExtension } from './launch.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const extensionPath = join(root, 'dist-e2e');
const fixtureHtml = await readFile(join(root, 'tests/e2e/fixture/index.html'));
const FIXTURE_PATH = '/design/FixtureKey1234567/Fixture-File';

let step = 0;
const log = (message) => console.log(`  ${String(++step).padStart(2, '0')}. ${message}`);

// --- local fixture server -----------------------------------------------------
const server = createServer((req, res) => {
  if (req.url?.startsWith('/design/')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(fixtureHtml);
  } else if (req.url === '/favicon.ico') {
    res.writeHead(204);
    res.end();
  } else {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const pageUrl = `${origin}${FIXTURE_PATH}?node-id=1-2&t=SECRETTOKEN`;

const browser = await launchWithExtension(extensionPath);
const { context } = browser;

const requests = [];
const pageErrors = [];
context.on('request', (request) => requests.push(request.url()));
context.on('weberror', (error) => pageErrors.push(String(error.error())));

let failed = false;
try {
  console.log(`Design Overlay Notes — e2e smoke test (${browser.label})`);
  const sw =
    context.serviceWorkers().find((w) => w.url().endsWith('/service-worker-loader.js')) ??
    (await context.waitForEvent('serviceworker'));
  const extensionId = new URL(sw.url()).host;
  log(`extension loaded (${extensionId})`);

  const commands = await sw.evaluate(() => chrome.commands.getAll());
  const unassigned = commands.filter((c) => !c.shortcut).map((c) => c.name);
  assert.deepEqual(unassigned, [], `Chrome refused suggested shortcuts for: ${unassigned.join(', ')}`);
  log(`all default shortcuts registered (${commands.map((c) => c.shortcut).join(', ')})`);

  const page = await context.newPage();
  page.on('console', (msg) => {
    if (msg.type() === 'error') pageErrors.push(`[page] ${msg.text()}`);
  });
  await page.goto(pageUrl);
  await page.bringToFront();
  const tabId = await sw.evaluate(async (url) => (await chrome.tabs.query({ url }))[0]?.id, pageUrl);
  assert.ok(tabId, 'fixture tab found');

  // Helpers that read the extension's IndexedDB from the service worker.
  const readStore = (store) =>
    sw.evaluate(
      (storeName) =>
        new Promise((resolve, reject) => {
          const open = indexedDB.open('design-overlay-notes');
          open.onerror = () => reject(open.error);
          open.onsuccess = () => {
            const req = open.result.transaction(storeName).objectStore(storeName).getAll();
            req.onsuccess = () => {
              const rows = req.result.map((row) => {
                const copy = { ...row };
                for (const [k, v] of Object.entries(copy)) if (v instanceof Blob) copy[k] = { blobSize: v.size, type: v.type };
                return copy;
              });
              open.result.close();
              resolve(rows);
            };
            req.onerror = () => reject(req.error);
          };
        }),
      store,
    );
  const waitFor = async (fn, what, timeout = 8_000) => {
    const start = Date.now();
    for (;;) {
      const value = await fn();
      if (value) return value;
      if (Date.now() - start > timeout) throw new Error(`Timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 150));
    }
  };
  const badge = () => sw.evaluate((id) => chrome.action.getBadgeText({ tabId: id }), tabId);
  const counts = () => page.evaluate(() => ({ ...window.__counts }));
  /** Pixel [r,g,b,a] of a capture's stored screenshot, read in the service worker. */
  const screenshotPixel = (captureId, x, y) =>
    sw.evaluate(
      ({ captureId, x, y }) =>
        new Promise((resolve, reject) => {
          const open = indexedDB.open('design-overlay-notes');
          open.onsuccess = () => {
            const req = open.result.transaction('captureImages').objectStore('captureImages').get(captureId);
            req.onsuccess = async () => {
              const bitmap = await createImageBitmap(req.result.screenshot);
              const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
              const ctx = canvas.getContext('2d');
              ctx.drawImage(bitmap, 0, 0);
              resolve([...ctx.getImageData(x, y, 1, 1).data]);
              open.result.close();
            };
            req.onerror = () => reject(req.error);
          };
        }),
      { captureId, x, y },
    );

  // --- activation + capture ---------------------------------------------------
  // First click on the icon: only the toolbar, no capture yet.
  await sw.evaluate((id) => globalThis.__overlayNotesE2E.activate(id), tabId);
  const opened = await waitFor(
    () => sw.evaluate((id) => chrome.tabs.sendMessage(id, { type: 'PING' }, { frameId: 0 }).catch(() => null), tabId).then((r) => (r?.data?.mode === 'browse' ? r.data : null)),
    'toolbar shown',
  );
  // (Don't read IndexedDB here: opening a missing database would create an empty one.)
  assert.equal(opened.captureId, null, 'no capture on the first activation');
  // Second click (or Annotate): capture the view and start drawing.
  await sw.evaluate((id) => globalThis.__overlayNotesE2E.activate(id), tabId);
  await waitFor(
    () => sw.evaluate((id) => chrome.tabs.sendMessage(id, { type: 'PING' }, { frameId: 0 }).catch(() => null), tabId).then((r) => r?.data?.captureId ?? null),
    'capture taken',
  );
  const captures = await waitFor(async () => {
    const rows = await readStore('captures');
    return rows.length === 1 ? rows : null;
  }, 'first capture');
  const capture = captures[0];
  log('first activation shows only the toolbar; the second captures the view and starts drawing');
  assert.equal(await page.locator('design-overlay-notes').count(), 1, 'exactly one overlay host');
  assert.equal(await page.evaluate(() => document.querySelector('design-overlay-notes').shadowRoot), null, 'closed shadow root');
  log('one overlay host mounted with a closed Shadow DOM');

  const live = await page.evaluate(() => ({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio }));
  assert.equal(capture.viewportCssWidth, live.w);
  assert.equal(capture.viewportCssHeight, live.h);
  assert.equal(capture.devicePixelRatio, live.dpr);
  assert.equal(capture.screenshotPixelWidth, Math.round(live.w * live.dpr));
  assert.equal(capture.screenshotPixelHeight, Math.round(live.h * live.dpr));
  assert.equal(capture.pageUrl, `${origin}${FIXTURE_PATH}?node-id=1-2`, 'URL sanitized (tracking token removed)');
  assert.equal(capture.pageTitle, 'Fixture File');
  const [project] = await readStore('projects');
  assert.equal(project.name, 'Fixture File');
  assert.equal(project.fileKey, 'FixtureKey1234567');
  log('capture metadata, sanitized URL and project grouping are correct');

  const images = await readStore('captureImages');
  assert.equal(images[0].screenshot.type, 'image/png');
  assert.ok(images[0].thumbnail?.blobSize > 0, 'thumbnail stored');
  log('screenshot PNG and thumbnail stored in extension IndexedDB');

  await waitFor(async () => (await badge()) === 'ON', 'annotate badge');
  log('annotate mode active (toolbar badge ON)');

  // --- drawing ----------------------------------------------------------------
  const before = await counts();
  await page.mouse.move(300, 300);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) await page.mouse.move(300 + i * 10, 300 + i * 4);
  await page.mouse.up();

  await page.keyboard.press('r');
  await page.mouse.move(450, 200);
  await page.mouse.down();
  await page.mouse.move(600, 260, { steps: 6 });
  await page.mouse.up();

  await page.keyboard.press('t');
  await page.mouse.click(250, 480);
  await page.waitForTimeout(150);
  await page.keyboard.type('Hello note <b>');
  await page.keyboard.press('Escape'); // finish text
  await page.mouse.wheel(0, 300);

  const annotations = await waitFor(async () => {
    const rows = await readStore('annotations');
    return rows.length === 3 ? rows : null;
  }, 'three saved annotations');
  const types = annotations.sort((a, b) => a.zIndex - b.zIndex).map((a) => a.type);
  assert.deepEqual(types, ['stroke', 'rectangle', 'text']);
  assert.equal(annotations.find((a) => a.type === 'text').text, 'Hello note <b>');
  log('pen stroke, rectangle and text note drawn and autosaved');

  const afterDraw = await counts();
  assert.equal(afterDraw.keydown - before.keydown, 0, 'page saw no keydown while annotating');
  assert.equal(afterDraw.pointerdown - before.pointerdown, 0, 'page saw no pointerdown while annotating');
  assert.equal(afterDraw.wheel - before.wheel, 0, 'page saw no wheel while annotating');
  log('keyboard, pointer and wheel input did not leak to the page while annotating');

  // --- undo / redo ------------------------------------------------------------
  await page.keyboard.press('Control+z');
  await waitFor(async () => (await readStore('annotations')).length === 2, 'undo saved');
  await page.keyboard.press('Control+Shift+z');
  await waitFor(async () => (await readStore('annotations')).length === 3, 'redo saved');
  log('undo/redo work and are persisted');

  // --- browse mode pass-through ----------------------------------------------
  await page.keyboard.press('Escape');
  await waitFor(async () => (await badge()) === '', 'browse mode');
  await page.mouse.click(980, 624);
  assert.equal((await counts()).buttonClicks, 1, 'click reached the page in browse mode');
  log('Escape returns to browse mode and clicks pass through to the page');

  // --- repeated activation ----------------------------------------------------
  await sw.evaluate((id) => globalThis.__overlayNotesE2E.activate(id), tabId);
  await waitFor(async () => (await badge()) === 'ON', 'annotate again');
  assert.equal(await page.locator('design-overlay-notes').count(), 1, 'still one host');
  assert.equal((await readStore('captures')).length, 1, 'toggle does not create a capture');
  await page.keyboard.press('Escape');
  log('repeated activation toggles mode without duplicate overlays');

  // --- second capture must not contain existing marks or the toolbar -------------
  await sw.evaluate((id) => globalThis.__overlayNotesE2E.newCapture(id), tabId);
  const second = await waitFor(async () => {
    const rows = await readStore('captures');
    return rows.length === 2 ? rows.find((c) => c.id !== capture.id) : null;
  }, 'second capture');
  // On the first capture's screenshot the stroke area is plain page background.
  // The second capture was taken while the marks were visible in browse mode:
  // they (and the toolbar at the top centre) must not be in the image.
  const sx = capture.screenshotPixelWidth / capture.viewportCssWidth; // screenshot px per CSS px
  const strokePixel = await screenshotPixel(second.id, Math.round(350 * sx), Math.round(320 * sx));
  const toolbarPixel = await screenshotPixel(second.id, Math.round(640 * sx), Math.round(30 * sx));
  const frameWhite = [255, 255, 255, 255]; // the stroke was drawn over the fixture's white #frame
  const pageBg = [233, 236, 239, 255];
  assert.deepEqual(strokePixel, frameWhite, `stroke not baked into screenshot (got ${strokePixel})`);
  assert.deepEqual(toolbarPixel, pageBg, `toolbar not baked into screenshot (got ${toolbarPixel})`);
  log('new capture hides overlay + toolbar: base screenshot is clean');

  // --- review page + PNG export ----------------------------------------------
  const review = await context.newPage();
  review.on('console', (msg) => {
    if (msg.type() === 'error') pageErrors.push(`[review] ${msg.text()}`);
  });
  await review.goto(`chrome-extension://${extensionId}/src/review/index.html?capture=${capture.id}`);
  await review.waitForSelector('svg.rv-canvas');
  assert.equal(await review.locator('svg.rv-canvas [data-annotation-id]').count(), 3);
  const [download] = await Promise.all([review.waitForEvent('download'), review.getByRole('button', { name: /Export PNG/ }).click()]);
  const pngBytes = await readFile(await download.path());
  const exported = await review.evaluate(async ({ base64, scale }) => {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    // Sample along the stroke path to find red ink.
    let red = 0;
    for (let i = 0; i <= 120; i += 2) {
      const [r, g, b] = ctx.getImageData(Math.round((300 + i) * scale), Math.round((300 + i * 0.4) * scale), 1, 1).data;
      if (r > 180 && g < 120 && b < 120) red++;
    }
    return { width: bitmap.width, height: bitmap.height, red };
  }, { base64: pngBytes.toString('base64'), scale: sx });
  assert.equal(exported.width, capture.screenshotPixelWidth);
  assert.equal(exported.height, capture.screenshotPixelHeight);
  assert.ok(exported.red > 10, `exported PNG contains the red stroke (${exported.red} red samples)`);
  assert.match(download.suggestedFilename(), /\.png$/);
  log(`review page renders marks; PNG export ${exported.width}×${exported.height} contains the annotations`);

  // --- side panel (as a tab) --------------------------------------------------
  const panel = await context.newPage();
  panel.on('console', (msg) => {
    if (msg.type() === 'error') pageErrors.push(`[panel] ${msg.text()}`);
  });
  await panel.goto(`chrome-extension://${extensionId}/src/sidepanel/index.html`);
  await panel.getByRole('heading', { name: 'Fixture File' }).waitFor();
  assert.equal(await panel.locator('article.dp-card').count(), 2);
  await panel.getByRole('searchbox').fill('hello note');
  await panel.waitForFunction(() => document.querySelectorAll('article.dp-card').length === 1);
  log('side panel lists the project and captures; note-text search works');

  // --- deleting the open capture in the manager closes it on the page ------------
  await panel.getByRole('searchbox').fill('');
  await panel.waitForFunction(() => document.querySelectorAll('article.dp-card').length === 2);
  const newest = panel.locator('article.dp-card').first(); // newest first = the capture open on the page
  await newest.getByRole('button', { name: 'More actions' }).click();
  await newest.getByRole('menuitem', { name: /Delete capture/ }).click();
  await newest.getByRole('button', { name: 'Delete', exact: true }).click();
  await waitFor(async () => (await readStore('captures')).length === 1, 'capture deleted');
  // The manager's own list must update without a reload.
  await panel.waitForFunction(() => document.querySelectorAll('article.dp-card').length === 1, null, { timeout: 3_000 });
  const ping = () => sw.evaluate((id) => chrome.tabs.sendMessage(id, { type: 'PING' }, { frameId: 0 }), tabId);
  await waitFor(async () => (await ping()).data?.mode === 'closed', 'overlay closed after delete');
  assert.equal((await readStore('captureImages')).length, 1, 'screenshot deleted with the capture');
  log('deleting the open capture in the manager removes it from the list at once and closes it on the page');

  // --- show a saved capture over the live page ----------------------------------
  await page.bringToFront();
  const windowId = await sw.evaluate((id) => chrome.tabs.get(id).then((t) => t.windowId), tabId);
  const shown = await panel.evaluate(
    ({ windowId, captureId }) =>
      chrome.runtime.sendMessage({ type: 'PANEL_SHOW_ON_PAGE', windowId, captureId, force: false }),
    { windowId, captureId: capture.id },
  );
  assert.deepEqual(shown, { ok: true, data: { status: 'shown' } });
  const restored = await waitFor(async () => {
    const status = (await ping()).data;
    return status?.captureId === capture.id ? status : null;
  }, 'capture shown on page');
  assert.equal(restored.mode, 'browse');
  log('a saved capture can be shown over the live page from the manager');

  // --- projects: make your own, send a file's new captures to it, move captures ----
  // The Figma-like tab stays the active tab; the manager (another tab) is driven in the background.
  await page.bringToFront();
  const target = panel.locator('.dp-target select');
  await target.waitFor({ timeout: 8_000 });
  await panel.getByRole('button', { name: 'New project' }).click();
  await panel.getByRole('textbox', { name: 'Project name' }).fill('Checkout redesign');
  assert.equal(await panel.getByRole('checkbox', { name: /Save new captures from “Fixture File” here/ }).isChecked(), true);
  await panel.getByRole('button', { name: 'Create project' }).click();
  const ownProject = await waitFor(
    async () => (await readStore('projects')).find((p) => p.name === 'Checkout redesign'),
    'new project stored',
  );
  assert.equal(ownProject.fileKey, null, 'a project of your own is not tied to a file');
  await waitFor(async () => (await target.evaluate((el) => el.selectedOptions[0]?.textContent)) === 'Checkout redesign', 'picker shows the new project');
  const routed = await panel.evaluate((windowId) => chrome.runtime.sendMessage({ type: 'PANEL_NEW_CAPTURE', windowId }), windowId);
  assert.ok(routed.ok && routed.data.captureId, 'new capture from the manager');
  const routedCapture = await waitFor(
    async () => (await readStore('captures')).find((c) => c.id === routed.data.captureId),
    'routed capture stored',
  );
  assert.equal(routedCapture.projectId, ownProject.id, 'new capture saved in the chosen project');
  log('a new project can be made in the manager; the file’s new captures then go to it');

  const ownSection = panel.locator('section.dp-project', { has: panel.getByRole('heading', { name: 'Checkout redesign' }) });
  await ownSection.locator('article.dp-card').first().waitFor();
  const movedCard = ownSection.locator('article.dp-card').first();
  await movedCard.getByRole('button', { name: 'More actions' }).click();
  await movedCard.getByRole('menuitem', { name: /Move to project/ }).click();
  await movedCard.getByRole('combobox', { name: 'Move to project' }).selectOption({ label: 'Fixture File' });
  await movedCard.getByRole('button', { name: 'Move', exact: true }).click();
  await waitFor(
    async () => (await readStore('captures')).find((c) => c.id === routedCapture.id)?.projectId === project.id,
    'capture moved back to the file’s project',
  );
  await target.selectOption('');
  await waitFor(
    async () => Object.keys((await sw.evaluate(() => chrome.storage.local.get('captureTargets'))).captureTargets ?? {}).length === 0,
    'file’s own project chosen again',
  );
  log('captures move between projects; the file’s own project can be chosen again');

  // --- backup export -----------------------------------------------------------
  await panel.bringToFront();
  await panel.getByRole('button', { name: /Settings, backup and privacy/ }).click();
  const [backup] = await Promise.all([panel.waitForEvent('download'), panel.getByRole('button', { name: /Export backup/ }).click()]);
  assert.match(backup.suggestedFilename(), /^design-overlay-notes-backup_.*\.zip$/);
  log('backup ZIP export works');

  // --- privacy: no network traffic beyond the fixture and the extension ---------
  const external = requests.filter(
    (url) => !url.startsWith(origin) && !url.startsWith('chrome-extension://') && !url.startsWith('data:') && !url.startsWith('blob:'),
  );
  assert.deepEqual(external, [], `unexpected network requests: ${external.join(', ')}`);
  log(`no external network requests (${requests.length} local requests observed)`);

  const relevantErrors = pageErrors.filter((e) => !/favicon/i.test(e));
  assert.deepEqual(relevantErrors, [], 'no page/extension errors');
  log('no console errors in page, review page or side panel');

  console.log(`\nPASS — ${step} checks`);
} catch (error) {
  failed = true;
  console.error('\nFAIL:', error);
  if (pageErrors.length) console.error('Collected errors:', pageErrors);
} finally {
  await browser.close();
  server.close();
}
process.exit(failed ? 1 : 0);
