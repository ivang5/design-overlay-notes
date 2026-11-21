# Design Overlay Notes

A private, local-only Chrome extension for drawing and writing personal notes on top of Figma designs in the browser. It never modifies the Figma file and makes no network requests. All data stays in the local Chrome profile.

## Features

- **Drawing overlay on Figma:** pen, highlighter, arrow, rectangle, ellipse, text notes, sticky notes, eraser, select/move/resize (including freehand drawings), undo/redo, colors, stroke sizes and font sizes.
- **Notes follow the design:** when you scroll, zoom or drag the Figma canvas (mouse, trackpad, hand tool, keyboard), notes move and scale with it in real time. This also works while drawing and after reopening a file. **Go to captured view** brings Figma back to exactly where a capture was taken.
- **Captures:** each set of notes is tied to a screenshot of the Figma view taken when annotating starts, so notes keep their context after the design changes.
- **Drawing and browse modes:** while drawing, Figma receives no clicks or keys (scrolling and zooming still reach the canvas). In browse mode, notes stay visible and clicks go through to Figma.
- **Autosave** with a visible warning if saving fails.
- **Notes manager (side panel):** captures grouped per Figma file, thumbnails, search (including note text), labels, descriptions, rename, duplicate, delete, **Open in Figma** (reuses or opens the file's tab, switches to the right page, finds the notes and returns to the captured view), and showing a saved capture over the current tab.
- **Review page:** a full-size view of each capture with editing.
- **Export and backup:** annotated PNG per capture (download or copy to the clipboard), plus full backup and restore as a `.zip`.
- **Privacy:** stored in the extension's IndexedDB only, with no account, sync or analytics. Screenshots used to follow the Figma view are compared in memory and never stored. Uses 4 permissions (`activeTab`, `scripting`, `storage`, `sidePanel`), plus optional access to www.figma.com if you enable it in Settings. Local data is not encrypted.

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

Notes are attached to the captured view, not to Figma layers. When you scroll or zoom, the extension finds the captured area again and moves the notes with it. If the area is not visible, the notes are hidden until you scroll back to it. Following can be turned off with the target button in the toolbar or in Settings. Take a new capture (**Alt+Shift+S**) for notes about a different area.

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
| `npm run test:e2e`  | Build `dist-e2e/` and run the end-to-end tests in Chrome |
| `npm run typecheck` | TypeScript only                                         |
| `npm run icons`     | Regenerate PNG icons from `assets/icon.svg`             |
| `npm run package`   | Build and zip `dist/` into `design-overlay-notes.zip`   |

Only `npm run build` output is meant for real use. The dev and e2e builds have broader permissions.
