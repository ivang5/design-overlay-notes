// End-to-end test for view tracking: marks follow a Figma-like canvas that is
// panned and zoomed (wheel, Ctrl+wheel, keyboard zoom-to-fit, drawing-mode
// scrolling), are hidden when the captured area is not on screen, and come
// back when it is. Ground truth comes from the fixture's own view transform.
//
//   npm run test:e2e   (runs after the smoke test; same browser options)
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchWithExtension } from './launch.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const extensionPath = join(root, 'dist-e2e');
const fixtureHtml = await readFile(join(root, 'tests/e2e/fixture/canvas.html'));
const FIXTURE_PATH = '/design/CanvasKey1234567890/Canvas-Fixture';

let step = 0;
const log = (message) => console.log(`  ${String(++step).padStart(2, '0')}. ${message}`);

const server = createServer((req, res) => {
  if (req.url?.startsWith('/design/')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(fixtureHtml);
  } else {
    res.writeHead(req.url === '/favicon.ico' ? 204 : 404);
    res.end();
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const pageUrl = `http://127.0.0.1:${server.address().port}${FIXTURE_PATH}`;

const browser = await launchWithExtension(extensionPath);
const { context } = browser;
const pageErrors = [];
context.on('weberror', (error) => pageErrors.push(String(error.error())));

let failed = false;
try {
  console.log(`Design Overlay Notes — view tracking e2e (${browser.label})`);
  const sw =
    context.serviceWorkers().find((w) => w.url().endsWith('/service-worker-loader.js')) ??
    (await context.waitForEvent('serviceworker'));
  const page = await context.newPage();
  page.on('console', (msg) => {
    if (msg.type() === 'error') pageErrors.push(`[page] ${msg.text()}`);
  });
  await page.goto(pageUrl);
  await page.bringToFront();
  const tabId = await sw.evaluate(async (url) => (await chrome.tabs.query({ url }))[0]?.id, pageUrl);
  assert.ok(tabId, 'fixture tab found');

  const fixtureView = () => page.evaluate(() => ({ ...window.__view }));
  const overlayView = () =>
    page.evaluate(() => {
      const raw = document.documentElement.dataset.donView;
      return raw ? JSON.parse(raw) : null;
    });
  const waitFor = async (fn, what, timeout = 10_000) => {
    const start = Date.now();
    let last;
    for (;;) {
      last = await fn();
      if (last && last.ok) return last;
      if (Date.now() - start > timeout) throw new Error(`Timed out waiting for ${what}: ${JSON.stringify(last)}`);
      await new Promise((r) => setTimeout(r, 200));
    }
  };

  // Capture-time fixture view: capture px → live px = V_live ∘ V_cap⁻¹.
  await sw.evaluate((id) => globalThis.__overlayNotesE2E.activate(id), tabId);
  await waitFor(async () => ({ ok: (await overlayView())?.status === 'following' }), 'tracking to start');
  const captureView = await fixtureView();
  const viewport = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
  log('capture taken on a canvas page; tracking active');

  /** Max on-screen error (px) between the overlay transform and the truth, over the canvas area. */
  const alignmentError = async () => {
    const [live, ov] = await Promise.all([fixtureView(), overlayView()]);
    if (!ov) return { ok: false, error: Infinity };
    const s = live.s / captureView.s;
    const truth = { s, tx: live.tx - s * captureView.tx, ty: live.ty - s * captureView.ty };
    let error = 0;
    for (const [x, y] of [
      [240, 0],
      [viewport.w - 240, 0],
      [240, viewport.h],
      [viewport.w - 240, viewport.h],
    ]) {
      error = Math.max(
        error,
        Math.hypot(truth.s * x + truth.tx - (ov.s * x + ov.tx), truth.s * y + truth.ty - (ov.s * y + ov.ty)),
      );
    }
    return { ok: true, error, status: ov.status, overlay: ov, truth };
  };
  /** Error of the *live* (predicted, not yet confirmed) transform right now. */
  const liveError = async () => {
    const [live, raw] = await Promise.all([fixtureView(), page.evaluate(() => document.documentElement.dataset.donLive)]);
    const ov = raw ? JSON.parse(raw) : null;
    if (!ov) return Infinity;
    const s = live.s / captureView.s;
    let error = 0;
    for (const [x, y] of [
      [240, 0],
      [viewport.w - 240, viewport.h],
    ]) {
      error = Math.max(error, Math.hypot(s * x + live.tx - s * captureView.tx - (ov.s * x + ov.tx), s * y + live.ty - s * captureView.ty - (ov.s * y + ov.ty)));
    }
    return error;
  };
  const expectInstant = async (what) => {
    // One frame: Figma (and the fixture) apply zoom steps at the next frame.
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const error = await liveError();
    assert.ok(error < 1.5, `${what}: marks should follow in the same frame (error ${error.toFixed(2)}px)`);
    log(`${what}: marks moved with the canvas immediately (error ${error.toFixed(2)}px before any check)`);
  };
  const expectAligned = async (what, tolerance) => {
    const result = await waitFor(async () => {
      const r = await alignmentError();
      return { ...r, ok: r.ok && r.status === 'following' && r.error <= tolerance };
    }, `${what} (≤ ${tolerance}px)`);
    log(`${what}: marks follow (error ${result.error.toFixed(2)}px, scale ${result.overlay.s.toFixed(3)})`);
  };

  // Draw a rectangle so our own ink is on screen during later alignments.
  await page.keyboard.press('r');
  await page.mouse.move(520, 260);
  await page.mouse.down();
  await page.mouse.move(700, 380, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.press('Escape'); // → browse mode
  await page.waitForTimeout(400);

  // 1. Wheel pan in browse mode: predicted exactly in the same frame, then confirmed.
  await page.mouse.move(640, 400);
  await page.mouse.wheel(0, 90);
  await page.mouse.wheel(-70, 0);
  await expectInstant('wheel pan');
  await expectAligned('wheel pan', 1.5);

  // 1b. A large wheel step: we predict Figma's 120 px cap, the fixture caps at 100 → small eased correction.
  await page.mouse.wheel(0, 150);
  await expectAligned('wheel pan with a prediction error (corrected)', 1.5);

  // 2. Ctrl+wheel zoom about the pointer (fixture uses Figma's zoom curve).
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -100);
  await page.mouse.wheel(0, -60);
  await page.keyboard.up('Control');
  await expectInstant('Ctrl+wheel zoom');
  await expectAligned('Ctrl+wheel zoom', 2.5);

  // 2b. Hand tool drag: followed live while the pointer moves.
  await page.keyboard.press('h');
  await page.mouse.move(700, 450);
  await page.mouse.down();
  await page.mouse.move(640, 410, { steps: 4 });
  await page.mouse.move(560, 380, { steps: 4 });
  await expectInstant('hand-tool drag (mid-drag)');
  await page.mouse.up();
  await page.keyboard.press('v');
  await expectAligned('hand-tool drag', 1.5);

  // 3. Keyboard zoom-to-fit (unpredictable): marks hidden, then found again.
  await page.keyboard.press('Shift+1');
  await expectAligned('keyboard zoom to fit', 2.5);

  // 4. Drawing mode: scrolling over the overlay is forwarded to the canvas.
  await sw.evaluate((id) => globalThis.__overlayNotesE2E.activate(id), tabId); // toggle → annotate
  await page.waitForTimeout(300);
  const before = await fixtureView();
  await page.mouse.move(700, 450);
  await page.mouse.wheel(0, 100);
  const after = await waitFor(async () => {
    const v = await fixtureView();
    return { ...v, ok: v.ty !== before.ty };
  }, 'forwarded wheel to move the canvas');
  assert.ok(Math.abs(after.ty - before.ty - -100) < 0.01, 'canvas panned by the forwarded wheel delta');
  await expectAligned('wheel while drawing (forwarded to the canvas)', 1.5);
  await page.keyboard.press('Escape');

  // 5. Different page: capture area not visible → marks hidden; back → found again.
  await page.keyboard.press('PageDown');
  await waitFor(async () => ({ ok: ['lost', 'searching'].includes((await overlayView())?.status) }), 'marks hidden on another page');
  await waitFor(async () => ({ ok: (await overlayView())?.status === 'lost' }), 'lost state', 15_000);
  log('switching to a page without the captured area hides the marks');
  await page.keyboard.press('PageUp');
  await expectAligned('back on the captured page', 2.5);

  // 6. "Open in Figma" from the manager: reuses this tab, finds the area and
  //    scrolls/zooms the canvas back to the captured view.
  await page.mouse.move(800, 400);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, 120);
  await page.keyboard.up('Control');
  await page.mouse.wheel(60, -80);
  await expectAligned('moved away before Open in Figma', 2.5);
  const captureId = await sw.evaluate(
    () =>
      new Promise((resolve) => {
        const open = indexedDB.open('design-overlay-notes');
        open.onsuccess = () => {
          const req = open.result.transaction('captures').objectStore('captures').getAll();
          req.onsuccess = () => resolve(req.result.sort((a, b) => b.createdAt - a.createdAt)[0].id);
        };
      }),
  );
  const opener = await context.newPage();
  await opener.goto(`chrome-extension://${new URL(sw.url()).host}/src/sidepanel/index.html`);
  const windowId = await sw.evaluate((id) => chrome.tabs.get(id).then((t) => t.windowId), tabId);
  const tabsBefore = context.pages().length;
  const opened = await opener.evaluate(
    ([windowId, captureId]) => chrome.runtime.sendMessage({ type: 'PANEL_OPEN_IN_FIGMA', windowId, captureId }),
    [windowId, captureId],
  );
  await opener.close();
  assert.deepEqual(opened, { ok: true, data: { status: 'shown' } });
  assert.equal(context.pages().length, tabsBefore - 1, 'the existing tab was reused (no new tab)');
  await waitFor(async () => {
    const v = await fixtureView();
    const error = Math.max(Math.abs(v.s / captureView.s - 1) * 1000, Math.abs(v.tx - captureView.tx), Math.abs(v.ty - captureView.ty));
    return { ok: error < 1, error, v };
  }, 'canvas back at the captured view');
  await expectAligned('Open in Figma restored the captured view', 1.5);

  // 6a. The reported case: zoom far out, travel far into the empty canvas
  //     (nothing to confirm the position against), then Open in Figma. The
  //     flight must land exactly (Figma caps each wheel step's length, so long
  //     diagonal flights used to fall short).
  await page.mouse.move(700, 300);
  for (let i = 0; i < 10; i++) {
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, 100);
    await page.keyboard.up('Control');
  }
  // Steps within both caps (fixture 100, Figma 120): predicted exactly, as on Figma.
  for (let i = 0; i < 20; i++) await page.mouse.wheel(0, 100);
  for (let i = 0; i < 20; i++) await page.mouse.wheel(-100, 0);
  await page.waitForTimeout(600);
  const farOpener = await context.newPage();
  await farOpener.goto(`chrome-extension://${new URL(sw.url()).host}/src/sidepanel/index.html`);
  const farOpened = await farOpener.evaluate(
    ([windowId, captureId]) => chrome.runtime.sendMessage({ type: 'PANEL_OPEN_IN_FIGMA', windowId, captureId }),
    [windowId, captureId],
  );
  await farOpener.close();
  assert.deepEqual(farOpened, { ok: true, data: { status: 'shown' } });
  await waitFor(async () => {
    const v = await fixtureView();
    const error = Math.max(Math.abs(v.s / captureView.s - 1) * 1000, Math.abs(v.tx - captureView.tx), Math.abs(v.ty - captureView.ty));
    return { ok: error < 1, error, v };
  }, 'canvas back at the captured view after a long trip');
  await expectAligned('Open in Figma after zooming far out and travelling far into empty canvas', 1.5);

  // 6a2. Figma moved in a way we could not follow (e.g. dragging its scrollbars)
  //      while the notes were off-screen: the landing check fails, the notes are
  //      found for real, and the second flight lands exactly.
  await page.mouse.move(700, 300);
  for (let i = 0; i < 6; i++) {
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, 100);
    await page.keyboard.up('Control');
  }
  for (let i = 0; i < 12; i++) await page.mouse.wheel(0, 100);
  await page.waitForTimeout(600);
  await page.evaluate(() => {
    window.__view.tx += 700;
    window.__view.ty -= 400;
    window.__draw();
  });
  await page.waitForTimeout(400);
  const jumpOpener = await context.newPage();
  await jumpOpener.goto(`chrome-extension://${new URL(sw.url()).host}/src/sidepanel/index.html`);
  const jumpStarted = Date.now();
  const jumpOpened = await jumpOpener.evaluate(
    ([windowId, captureId]) => chrome.runtime.sendMessage({ type: 'PANEL_OPEN_IN_FIGMA', windowId, captureId }),
    [windowId, captureId],
  );
  await jumpOpener.close();
  assert.deepEqual(jumpOpened, { ok: true, data: { status: 'shown' } });
  await waitFor(async () => {
    const v = await fixtureView();
    const error = Math.max(Math.abs(v.s / captureView.s - 1) * 1000, Math.abs(v.tx - captureView.tx), Math.abs(v.ty - captureView.ty));
    return { ok: error < 1, error, v };
  }, 'canvas back at the captured view after a move we could not follow', 20_000).catch(async (error) => {
    console.log(await page.evaluate(() => document.documentElement.dataset.donTrace));
    throw error;
  });
  await expectAligned(`Open in Figma after a move we could not follow (recovered in ${Date.now() - jumpStarted} ms)`, 1.5);

  // 6b. Same, but nothing is known about the view: the page was reloaded,
  //     switched to another page and scrolled far away. The extension switches
  //     back to the capture's page, zooms out to find the area, then flies to it.
  await page.reload();
  await page.waitForTimeout(500);
  await page.mouse.move(800, 400);
  for (let i = 0; i < 25; i++) await page.mouse.wheel(100, 40); // far away from the captured area
  await page.locator('button.page', { hasText: 'Page 2' }).click();
  const lookup = await context.newPage();
  await lookup.goto(`chrome-extension://${new URL(sw.url()).host}/src/sidepanel/index.html`);
  const started = Date.now();
  const reopened = await lookup.evaluate(
    ([windowId, captureId]) => chrome.runtime.sendMessage({ type: 'PANEL_OPEN_IN_FIGMA', windowId, captureId }),
    [windowId, captureId],
  );
  await lookup.close();
  assert.deepEqual(reopened, { ok: true, data: { status: 'shown' } });
  await waitFor(async () => {
    const v = await fixtureView();
    const onPage1 = await page.evaluate(() => window.__page() === 1);
    const error = Math.max(Math.abs(v.s / captureView.s - 1) * 1000, Math.abs(v.tx - captureView.tx), Math.abs(v.ty - captureView.ty));
    return { ok: onPage1 && error < 1.5, error, onPage1 };
  }, 'navigated back to the captured view', 20_000).catch(async (error) => {
    console.log(await page.evaluate(() => document.documentElement.dataset.donTrace));
    console.log(JSON.stringify(await sw.evaluate(() => (globalThis.__alignLog ?? []).slice(-6).map((e) => ({ ms: e.ms, ok: e.confident, hint: e.hint, t: e.transform, timings: e.timings, attempts: e.attempts?.map((a) => `${a.method} ${a.ncc}/${a.fine} n=${a.valid} s=${a.t.s.toFixed(3)}`) }))), null, 1));
    console.log(JSON.stringify(await fixtureView()));
    throw error;
  });
  await expectAligned(`Open in Figma from an unknown view (other page, far away) found the notes in ${Date.now() - started} ms`, 1.5);

  // 7. Turning following off returns marks to their capture position.
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${new URL(sw.url()).host}/src/sidepanel/index.html`);
  await panel.evaluate(async () => {
    const stored = (await chrome.storage.local.get('settings')).settings ?? {};
    await chrome.storage.local.set({ settings: { ...stored, followView: false } });
  });
  await panel.close();
  await waitFor(async () => {
    const ov = await overlayView();
    return { ok: ov?.status === 'off' && ov.s === 1 && ov.tx === 0 && ov.ty === 0 };
  }, 'follow off → identity');
  log('turning “keep notes attached” off pins marks to the capture position');

  const timings = await sw.evaluate(() => (globalThis.__alignLog ?? []).map((e) => e.ms));
  log(`alignment timings (ms): ${timings.join(', ')}`);
  if (process.env.E2E_VERBOSE) console.log(JSON.stringify(await sw.evaluate(() => (globalThis.__alignLog ?? []).filter((e) => e.ms > 300).map((e) => ({ ms: e.ms, hint: e.hint, ok: e.confident, t: e.timings, stages: e.stages })))));
  assert.deepEqual(pageErrors, [], `page errors: ${pageErrors.join('\n')}`);
  console.log(`\nPASS — ${step} checks`);
} catch (error) {
  failed = true;
  console.error('\nFAIL:', error);
} finally {
  await browser.close();
  server.close();
}
process.exit(failed ? 1 : 0);
