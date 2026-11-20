// Renders assets/icon.svg to the PNG sizes Chrome needs (written to public/icons/).
// Usage: node scripts/generate-icons.mjs   (uses Playwright's Chromium)
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const iconsDir = fileURLToPath(new URL('../public/icons/', import.meta.url));
const svg = await readFile(fileURLToPath(new URL('../assets/icon.svg', import.meta.url)), 'utf8');
// Set CHROMIUM_PATH to reuse an existing Chromium instead of `npx playwright install chromium`.
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const page = await browser.newPage({ deviceScaleFactor: 1 });
for (const size of [16, 32, 48, 128]) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<html><body style="margin:0;background:transparent">` +
      `<div style="width:${size}px;height:${size}px">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</div>` +
      `</body></html>`,
  );
  await page.screenshot({ path: `${iconsDir}icon-${size}.png`, omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
  console.log(`icon-${size}.png`);
}
await browser.close();
