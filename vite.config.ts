import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { crx } from '@crxjs/vite-plugin';
import manifest from './manifest.config.ts';

export default defineConfig(({ mode }) => {
  const isE2E = mode === 'e2e';
  return {
    plugins: [
      react(),
      crx({
        manifest,
        contentScripts: {
          // Build the overlay as one self-contained IIFE file so it can be
          // injected with chrome.scripting.executeScript({ files }) without a
          // module loader.
          standaloneFiles: ['src/content/entry.tsx'],
        },
      }),
    ],
    define: {
      __E2E__: JSON.stringify(isE2E),
      // CRXJS builds the IIFE content script in Vite library mode, which does
      // not replace this by default. Without it React's dev build is bundled
      // and `process` is undefined at runtime in the page.
      'process.env.NODE_ENV': JSON.stringify(mode === 'development' ? 'development' : 'production'),
    },
    build: {
      outDir: isE2E ? 'dist-e2e' : 'dist',
      emptyOutDir: true,
      target: 'chrome116',
      sourcemap: mode !== 'production' ? 'inline' : false,
      rolldownOptions: {
        input: {
          // Not referenced from the manifest, so it must be listed explicitly.
          review: resolve(import.meta.dirname, 'src/review/index.html'),
        },
      },
    },
    server: {
      port: 5173,
      strictPort: true,
      hmr: { port: 5173 },
      cors: { origin: [/chrome-extension:\/\//] },
    },
  };
});
