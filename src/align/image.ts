/**
 * Minimal grayscale image toolkit for view alignment (no DOM, runs in the
 * service worker and in unit tests).
 *
 * Coordinates are continuous: pixel (i, j) covers [i, i+1) × [j, j+1) and its
 * centre is at (i + 0.5, j + 0.5). With this convention halving an image maps
 * a coordinate X to exactly X / 2, which keeps transforms exact across
 * pyramid levels.
 */

export interface GrayImage {
  readonly width: number;
  readonly height: number;
  /** Row-major intensities, 0..255. */
  readonly data: Float32Array;
}

/** 1 = usable pixel, 0 = ignore (outside the canvas, Figma UI, our own marks…). */
export interface Mask {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

export function createImage(width: number, height: number, fill = 0): GrayImage {
  const data = new Float32Array(width * height);
  if (fill) data.fill(fill);
  return { width, height, data };
}

export function createMask(width: number, height: number, value: 0 | 1 = 1): Mask {
  const data = new Uint8Array(width * height);
  if (value) data.fill(1);
  return { width, height, data };
}

/** Rec. 601 luma from RGBA bytes. */
export function grayFromRgba(rgba: ArrayLike<number>, width: number, height: number): GrayImage {
  const out = createImage(width, height);
  const d = out.data;
  for (let i = 0, p = 0; i < d.length; i++, p += 4) {
    d[i] = 0.299 * rgba[p]! + 0.587 * rgba[p + 1]! + 0.114 * rgba[p + 2]!;
  }
  return out;
}

/** Bilinear sample at a continuous coordinate (clamped to the image). */
export function sample(img: GrayImage, x: number, y: number): number {
  const w = img.width;
  const h = img.height;
  let fx = x - 0.5;
  let fy = y - 0.5;
  if (fx < 0) fx = 0;
  else if (fx > w - 1) fx = w - 1;
  if (fy < 0) fy = 0;
  else if (fy > h - 1) fy = h - 1;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = x0 + 1 < w ? x0 + 1 : x0;
  const y1 = y0 + 1 < h ? y0 + 1 : y0;
  const ax = fx - x0;
  const ay = fy - y0;
  const d = img.data;
  const top = d[y0 * w + x0]! * (1 - ax) + d[y0 * w + x1]! * ax;
  const bottom = d[y1 * w + x0]! * (1 - ax) + d[y1 * w + x1]! * ax;
  return top * (1 - ay) + bottom * ay;
}

/** Is the mask set at the pixel containing this continuous coordinate? */
export function maskAt(mask: Mask, x: number, y: number): boolean {
  if (x < 0 || y < 0) return false;
  const i = Math.floor(x);
  const j = Math.floor(y);
  if (i >= mask.width || j >= mask.height) return false;
  return mask.data[j * mask.width + i] === 1;
}

/** Halve an image with a 2×2 box filter. */
export function downsample(img: GrayImage): GrayImage {
  const w = Math.max(1, img.width >> 1);
  const h = Math.max(1, img.height >> 1);
  const out = createImage(w, h);
  const src = img.data;
  const sw = img.width;
  for (let j = 0; j < h; j++) {
    const r0 = Math.min(2 * j, img.height - 1) * sw;
    const r1 = Math.min(2 * j + 1, img.height - 1) * sw;
    for (let i = 0; i < w; i++) {
      const c0 = Math.min(2 * i, sw - 1);
      const c1 = Math.min(2 * i + 1, sw - 1);
      out.data[j * w + i] = (src[r0 + c0]! + src[r0 + c1]! + src[r1 + c0]! + src[r1 + c1]!) / 4;
    }
  }
  return out;
}

/** Halve a mask; a coarse pixel is usable only if all four fine pixels are. */
export function downsampleMask(mask: Mask): Mask {
  const w = Math.max(1, mask.width >> 1);
  const h = Math.max(1, mask.height >> 1);
  const out = createMask(w, h, 0);
  const src = mask.data;
  const sw = mask.width;
  for (let j = 0; j < h; j++) {
    const r0 = Math.min(2 * j, mask.height - 1) * sw;
    const r1 = Math.min(2 * j + 1, mask.height - 1) * sw;
    for (let i = 0; i < w; i++) {
      const c0 = Math.min(2 * i, sw - 1);
      const c1 = Math.min(2 * i + 1, sw - 1);
      out.data[j * w + i] = src[r0 + c0]! & src[r0 + c1]! & src[r1 + c0]! & src[r1 + c1]!;
    }
  }
  return out;
}

/** Separable Gaussian blur. */
export function blur(img: GrayImage, sigma: number): GrayImage {
  if (sigma <= 0.01) return img;
  const radius = Math.max(1, Math.ceil(sigma * 2.5));
  const kernel = new Float32Array(radius * 2 + 1);
  let sum = 0;
  for (let k = -radius; k <= radius; k++) {
    const v = Math.exp(-(k * k) / (2 * sigma * sigma));
    kernel[k + radius] = v;
    sum += v;
  }
  for (let k = 0; k < kernel.length; k++) kernel[k]! /= sum;

  const { width: w, height: h } = img;
  const tmp = new Float32Array(w * h);
  const out = createImage(w, h);
  const src = img.data;
  for (let j = 0; j < h; j++) {
    const row = j * w;
    for (let i = 0; i < w; i++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) {
        let x = i + k;
        if (x < 0) x = 0;
        else if (x >= w) x = w - 1;
        acc += src[row + x]! * kernel[k + radius]!;
      }
      tmp[row + i] = acc;
    }
  }
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) {
        let y = j + k;
        if (y < 0) y = 0;
        else if (y >= h) y = h - 1;
        acc += tmp[y * w + i]! * kernel[k + radius]!;
      }
      out.data[j * w + i] = acc;
    }
  }
  return out;
}

/** Central-difference gradients. */
export function gradients(img: GrayImage): { gx: GrayImage; gy: GrayImage } {
  const { width: w, height: h, data } = img;
  const gx = createImage(w, h);
  const gy = createImage(w, h);
  for (let j = 0; j < h; j++) {
    const up = (j > 0 ? j - 1 : j) * w;
    const down = (j < h - 1 ? j + 1 : j) * w;
    const dyScale = j > 0 && j < h - 1 ? 0.5 : 1;
    for (let i = 0; i < w; i++) {
      const left = i > 0 ? i - 1 : i;
      const right = i < w - 1 ? i + 1 : i;
      const dxScale = i > 0 && i < w - 1 ? 0.5 : 1;
      gx.data[j * w + i] = (data[j * w + right]! - data[j * w + left]!) * dxScale;
      gy.data[j * w + i] = (data[down + i]! - data[up + i]!) * dyScale;
    }
  }
  return { gx, gy };
}

/**
 * Resample an image by factor f (< 1 shrinks). Pre-blurs when shrinking so
 * the result approximates an area average.
 */
export function rescale(img: GrayImage, f: number): GrayImage {
  const w = Math.max(1, Math.round(img.width * f));
  const h = Math.max(1, Math.round(img.height * f));
  const source = f < 1 ? blur(img, 0.45 / f) : img;
  const out = createImage(w, h);
  const sx = img.width / w;
  const sy = img.height / h;
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      out.data[j * w + i] = sample(source, (i + 0.5) * sx, (j + 0.5) * sy);
    }
  }
  return out;
}

/** Resample a mask by factor f; an output pixel is usable only if its whole footprint is. */
export function rescaleMask(mask: Mask, f: number): Mask {
  const w = Math.max(1, Math.round(mask.width * f));
  const h = Math.max(1, Math.round(mask.height * f));
  const out = createMask(w, h, 0);
  const sx = mask.width / w;
  const sy = mask.height / h;
  for (let j = 0; j < h; j++) {
    const y0 = Math.floor(j * sy);
    const y1 = Math.min(mask.height - 1, Math.ceil((j + 1) * sy) - 1);
    for (let i = 0; i < w; i++) {
      const x0 = Math.floor(i * sx);
      const x1 = Math.min(mask.width - 1, Math.ceil((i + 1) * sx) - 1);
      let ok = 1;
      for (let y = y0; y <= y1 && ok; y++) {
        for (let x = x0; x <= x1; x++) {
          if (!mask.data[y * mask.width + x]) {
            ok = 0;
            break;
          }
        }
      }
      out.data[j * w + i] = ok;
    }
  }
  return out;
}

/** Clear a rectangle (continuous coordinates, grown outward to whole pixels). */
export function clearMaskRect(mask: Mask, x: number, y: number, width: number, height: number): void {
  const x0 = Math.max(0, Math.floor(x));
  const y0 = Math.max(0, Math.floor(y));
  const x1 = Math.min(mask.width, Math.ceil(x + width));
  const y1 = Math.min(mask.height, Math.ceil(y + height));
  for (let j = y0; j < y1; j++) mask.data.fill(0, j * mask.width + x0, j * mask.width + Math.max(x0, x1));
}

export function countMask(mask: Mask): number {
  let n = 0;
  for (let i = 0; i < mask.data.length; i++) n += mask.data[i]!;
  return n;
}

export interface Cropped {
  image: GrayImage;
  mask: Mask;
  x0: number;
  y0: number;
}

/** Crop an image and its mask to the mask's bounding box (pixel offsets returned). */
export function cropToMask(image: GrayImage, mask: Mask): Cropped {
  let x0 = mask.width;
  let y0 = mask.height;
  let x1 = -1;
  let y1 = -1;
  for (let j = 0; j < mask.height; j++) {
    for (let i = 0; i < mask.width; i++) {
      if (!mask.data[j * mask.width + i]) continue;
      if (i < x0) x0 = i;
      if (i > x1) x1 = i;
      if (j < y0) y0 = j;
      if (j > y1) y1 = j;
    }
  }
  if (x1 < 0) return { image, mask, x0: 0, y0: 0 };
  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  const out = createImage(w, h);
  const outMask = createMask(w, h, 0);
  for (let j = 0; j < h; j++) {
    const src = (j + y0) * image.width + x0;
    out.data.set(image.data.subarray(src, src + w), j * w);
    outMask.data.set(mask.data.subarray((j + y0) * mask.width + x0, (j + y0) * mask.width + x0 + w), j * w);
  }
  return { image: out, mask: outMask, x0, y0 };
}
