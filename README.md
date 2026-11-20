# Design Overlay Notes

A private, local-only Chrome extension for drawing and writing personal notes on top of Figma designs in the browser. It never modifies the Figma file and makes no network requests. All data stays in the local Chrome profile.

## Features

- **Drawing overlay on Figma:** pen, highlighter, arrow, rectangle, ellipse, text notes, sticky notes, eraser, select/move/resize, undo/redo, colors and sizes.
- **Captures:** each set of notes is tied to a screenshot of the Figma view taken when annotating starts, so notes keep their context after the design changes.
- **Drawing and browse modes:** while drawing, Figma receives no mouse or keyboard input. In browse mode, notes stay visible and clicks go through to Figma.
- **Autosave**, with warnings when the window size, browser zoom or Figma file changes.
- **Notes manager (side panel):** captures grouped per Figma file, thumbnails, search (including note text), labels, descriptions, rename, duplicate, delete, and showing a saved capture over the current tab.
- **Review page:** a full-size view of each capture with editing.
- **Export and backup:** annotated PNG per capture, plus full backup and restore as a `.zip`.
- **Privacy:** stored in the extension's IndexedDB only, with no account, sync or analytics. Uses 4 permissions (`activeTab`, `scripting`, `storage`, `sidePanel`). Local data is not encrypted.

## Requirements

- Google Chrome 116+
- Node.js 20+ and npm

## Setup

```bash
npm install
npm run build
```

This builds the extension into `dist/`. To install it in Chrome:

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the `dist/` folder.
4. Pin the extension from the puzzle-piece menu.

**After code changes:** run `npm run build`, click reload ↻ on the extension card in `chrome://extensions`, then reload any open Figma tabs. Notes survive reloads and updates. Removing the extension deletes them, so export a backup first (Notes manager → ⚙ → Export backup).

## Usage

Open a Figma file (`https://www.figma.com/{design,file,proto,board}/...`) and click the extension icon or press **Alt+Shift+D**. Press **Esc** or click **Done** to return to Figma.

Notes are positioned on the screen, not on Figma layers. After panning or zooming the Figma canvas, take a new capture (**Alt+Shift+S**).

| Shortcut                 | Action                                                                         |
| ------------------------ | ------------------------------------------------------------------------------ |
| Alt+Shift+D              | Start annotating / toggle drawing mode                                         |
| Alt+Shift+S              | New capture                                                                    |
| Alt+Shift+O              | Hide / show notes                                                              |
| V P H A R O T S E        | Select, pen, highlighter, arrow, rectangle, ellipse, text, sticky note, eraser |
| Ctrl/⌘+Z, Ctrl/⌘+Shift+Z | Undo / redo                                                                    |
| Esc                      | Finish text → deselect → leave drawing mode                                    |

Global shortcuts can be changed at `chrome://extensions/shortcuts`.

## Development

| Command             | Description                                             |
| ------------------- | ------------------------------------------------------- |
| `npm run build`     | Type-check and build into `dist/`                       |
| `npm run dev`       | Development build with hot reload into `dist/`          |
| `npm test`          | Unit tests (Vitest)                                     |
| `npm run test:e2e`  | Build `dist-e2e/` and run the end-to-end test in Chrome |
| `npm run typecheck` | TypeScript only                                         |
| `npm run icons`     | Regenerate PNG icons from `assets/icon.svg`             |
| `npm run package`   | Build and zip `dist/` into `design-overlay-notes.zip`   |

Only `npm run build` output is meant for real use. The dev and e2e builds have broader permissions.
