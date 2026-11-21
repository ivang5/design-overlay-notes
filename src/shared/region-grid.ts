/**
 * Compact description of which parts of the viewport show the Figma canvas
 * (as opposed to Figma's panels, toolbars and dialogs). Cells of `cell` CSS
 * pixels, row-major, packed into a base64 bitset.
 */
export interface RegionGrid {
  /** Cell size in CSS pixels. */
  cell: number;
  cols: number;
  rows: number;
  /** Base64 of a bitset, bit k = cell k (LSB first within each byte). */
  bits: string;
}

export function encodeRegionGrid(cell: number, cols: number, rows: number, isCanvas: (col: number, row: number) => boolean): RegionGrid {
  const bytes = new Uint8Array(Math.ceil((cols * rows) / 8));
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      if (isCanvas(col, row)) {
        const k = row * cols + col;
        bytes[k >> 3]! |= 1 << (k & 7);
      }
    }
  }
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return { cell, cols, rows, bits: btoa(binary) };
}

/** Decode to one byte per cell (1 = canvas). Returns null when malformed. */
export function decodeRegionGrid(grid: RegionGrid): Uint8Array | null {
  let binary: string;
  try {
    binary = atob(grid.bits);
  } catch {
    return null;
  }
  const count = grid.cols * grid.rows;
  if (binary.length < Math.ceil(count / 8)) return null;
  const cells = new Uint8Array(count);
  for (let k = 0; k < count; k++) cells[k] = (binary.charCodeAt(k >> 3) >> (k & 7)) & 1;
  return cells;
}

export function regionGridCoverage(grid: RegionGrid): number {
  const cells = decodeRegionGrid(grid);
  if (!cells || cells.length === 0) return 0;
  let n = 0;
  for (const c of cells) n += c;
  return n / cells.length;
}
