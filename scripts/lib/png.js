import { deflateSync, inflateSync } from 'node:zlib';

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

const crc32 = (buf) => {
  let c = -1;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};

const chunk = (type, data) => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
};

const abs = (byte) => (byte < 128 ? byte : 256 - byte);

/**
 * Picks a filter for one scanline the way libpng does: try all five, keep the
 * one whose bytes sum smallest, on the theory that values near zero deflate
 * best. Flat colour barely cares, but a photographic icon does - filtering the
 * 512px logo this way cuts it by more than half.
 */
function filterRow(row, previous, bpp, out) {
  let best = null;
  let bestScore = Infinity;
  for (let type = 0; type < 5; type++) {
    let score = 0;
    for (let i = 0; i < row.length; i++) {
      const a = i >= bpp ? row[i - bpp] : 0;
      const b = previous[i];
      const c = i >= bpp ? previous[i - bpp] : 0;
      let value;
      switch (type) {
        case 0: value = row[i]; break;
        case 1: value = row[i] - a; break;
        case 2: value = row[i] - b; break;
        case 3: value = row[i] - ((a + b) >> 1); break;
        default: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          value = row[i] - (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
        }
      }
      value &= 0xff;
      out[type][i] = value;
      score += abs(value);
    }
    if (score < bestScore) { bestScore = score; best = type; }
  }
  return best;
}

/**
 * Minimal PNG encoder — no dependencies, good enough for icons and art.
 *
 * Takes RGBA in, and writes RGB when nothing is transparent: a photographic
 * icon is fully opaque, and dropping the alpha channel removes a quarter of
 * the bytes before they ever reach deflate. Every icon here is precached by
 * the service worker on install, so their size is a download every phone pays.
 */
export function encodePng(width, height, rgba) {
  let opaque = true;
  for (let i = 3; i < rgba.length; i += 4) {
    if (rgba[i] !== 255) { opaque = false; break; }
  }
  const channels = opaque ? 3 : 4;

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;                  // bit depth
  ihdr[9] = opaque ? 2 : 6;     // colour type: RGB or RGBA

  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  const candidates = Array.from({ length: 5 }, () => Buffer.alloc(stride));
  let previous = Buffer.alloc(stride);
  const row = Buffer.alloc(stride);

  for (let y = 0; y < height; y++) {
    if (channels === 4) {
      rgba.copy(row, 0, y * width * 4, (y + 1) * width * 4);
    } else {
      for (let x = 0; x < width; x++) {
        const src = (y * width + x) * 4;
        row[x * 3] = rgba[src];
        row[x * 3 + 1] = rgba[src + 1];
        row[x * 3 + 2] = rgba[src + 2];
      }
    }
    const chosen = filterRow(row, previous, channels, candidates);
    raw[y * (stride + 1)] = chosen;
    candidates[chosen].copy(raw, y * (stride + 1) + 1);
    previous = Buffer.from(row);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}


/**
 * Minimal PNG decoder, the other half of the encoder above. Enough to read an
 * exported logo back in and scale it: 8- and 16-bit, greyscale/RGB/palette,
 * with or without alpha. Interlaced files are rejected rather than guessed at.
 */
export function decodePng(buffer) {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (signature.some((byte, i) => buffer[i] !== byte)) throw new Error('Not a PNG file');

  let width = 0;
  let height = 0;
  let depth = 8;
  let colorType = 6;
  let palette = null;
  let transparency = null;
  const idat = [];

  for (let at = 8; at + 8 <= buffer.length;) {
    const length = buffer.readUInt32BE(at);
    const type = buffer.toString('ascii', at + 4, at + 8);
    const data = buffer.subarray(at + 8, at + 8 + length);
    at += 12 + length; // length + type + data + crc

    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      depth = data[8];
      colorType = data[9];
      if (data[12] !== 0) throw new Error('Interlaced PNGs are not supported');
    } else if (type === 'PLTE') palette = Buffer.from(data);
    else if (type === 'tRNS') transparency = Buffer.from(data);
    else if (type === 'IDAT') idat.push(Buffer.from(data));
    else if (type === 'IEND') break;
  }

  if (!width || !height) throw new Error('PNG has no image header');
  if (depth !== 8 && depth !== 16) throw new Error(`Unsupported bit depth ${depth}`);

  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`Unsupported colour type ${colorType}`);
  if (colorType === 3 && !palette) throw new Error('Palette image with no palette');

  const bytesPerPixel = Math.ceil((channels * depth) / 8);
  const rowBytes = Math.ceil((channels * depth * width) / 8);
  const raw = inflateSync(Buffer.concat(idat));

  // Undo the per-scanline filters. Each row predicts from the pixel to its
  // left (a), the row above (b) and that row's left neighbour (c).
  const pixels = Buffer.alloc(rowBytes * height);
  let read = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[read++];
    const row = y * rowBytes;
    const above = row - rowBytes;
    for (let i = 0; i < rowBytes; i++) {
      const x = raw[read++];
      const a = i >= bytesPerPixel ? pixels[row + i - bytesPerPixel] : 0;
      const b = y > 0 ? pixels[above + i] : 0;
      const c = y > 0 && i >= bytesPerPixel ? pixels[above + i - bytesPerPixel] : 0;
      let value;
      switch (filter) {
        case 0: value = x; break;
        case 1: value = x + a; break;
        case 2: value = x + b; break;
        case 3: value = x + ((a + b) >> 1); break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          value = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: throw new Error(`Unknown PNG filter ${filter}`);
      }
      pixels[row + i] = value & 0xff;
    }
  }

  // Everything becomes 8-bit RGBA, so callers only deal with one layout.
  const step = depth === 16 ? 2 : 1;
  const out = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const src = i * bytesPerPixel;
    const dst = i * 4;
    const at = (channel) => pixels[src + channel * step];
    if (colorType === 3) {
      const index = pixels[src];
      out[dst] = palette[index * 3];
      out[dst + 1] = palette[index * 3 + 1];
      out[dst + 2] = palette[index * 3 + 2];
      out[dst + 3] = transparency && index < transparency.length ? transparency[index] : 255;
    } else if (colorType === 0 || colorType === 4) {
      const grey = at(0);
      out[dst] = grey;
      out[dst + 1] = grey;
      out[dst + 2] = grey;
      out[dst + 3] = colorType === 4 ? at(1) : 255;
    } else {
      out[dst] = at(0);
      out[dst + 1] = at(1);
      out[dst + 2] = at(2);
      out[dst + 3] = colorType === 6 ? at(3) : 255;
    }
  }
  return { width, height, data: out };
}

/**
 * Area-average resize. Every destination pixel is the mean of the source
 * rectangle it covers, which is what a big reduction needs - sampling one
 * pixel out of forty (1254px of logo down to a 32px favicon) throws away most
 * of the image and keeps whatever noise it happened to land on. Alpha is
 * premultiplied first so transparent pixels cannot bleed their colour in.
 */
export function resize(image, width, height) {
  const out = Buffer.alloc(width * height * 4);
  const scaleX = image.width / width;
  const scaleY = image.height / height;

  for (let y = 0; y < height; y++) {
    const y0 = Math.floor(y * scaleY);
    const y1 = Math.max(y0 + 1, Math.min(image.height, Math.ceil((y + 1) * scaleY)));
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor(x * scaleX);
      const x1 = Math.max(x0 + 1, Math.min(image.width, Math.ceil((x + 1) * scaleX)));

      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const i = (sy * image.width + sx) * 4;
          const alpha = image.data[i + 3] / 255;
          r += image.data[i] * alpha;
          g += image.data[i + 1] * alpha;
          b += image.data[i + 2] * alpha;
          a += image.data[i + 3];
          n++;
        }
      }
      const dst = (y * width + x) * 4;
      const meanAlpha = a / n;
      const share = meanAlpha > 0 ? n * (meanAlpha / 255) : 1;
      out[dst] = Math.round(r / share);
      out[dst + 1] = Math.round(g / share);
      out[dst + 2] = Math.round(b / share);
      out[dst + 3] = Math.round(meanAlpha);
    }
  }
  return { width, height, data: out };
}

/** Centre-crops to a square, so a slightly off-square export still works. */
export function squareCrop(image) {
  const side = Math.min(image.width, image.height);
  if (side === image.width && side === image.height) return image;
  const left = Math.floor((image.width - side) / 2);
  const top = Math.floor((image.height - side) / 2);
  const out = Buffer.alloc(side * side * 4);
  for (let y = 0; y < side; y++) {
    image.data.copy(out, y * side * 4,
      ((top + y) * image.width + left) * 4,
      ((top + y) * image.width + left + side) * 4);
  }
  return { width: side, height: side, data: out };
}

/** Crops a fractional region: crop(logo, 0.54, 0.43, 0.2) is a 20% square. */
export function crop(image, x, y, size) {
  const side = Math.round(Math.min(image.width, image.height) * size);
  const left = Math.max(0, Math.min(image.width - side, Math.round(image.width * x - side / 2)));
  const top = Math.max(0, Math.min(image.height - side, Math.round(image.height * y - side / 2)));
  const out = Buffer.alloc(side * side * 4);
  for (let row = 0; row < side; row++) {
    image.data.copy(out, row * side * 4,
      ((top + row) * image.width + left) * 4,
      ((top + row) * image.width + left + side) * 4);
  }
  return { width: side, height: side, data: out };
}

/** The average colour of the outermost ring, for padding that blends in. */
export function edgeColor(image, ratio = 0.03) {
  const band = Math.max(1, Math.round(Math.min(image.width, image.height) * ratio));
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let y = 0; y < image.height; y++) {
    const edgeRow = y < band || y >= image.height - band;
    for (let x = 0; x < image.width; x++) {
      if (!edgeRow && x >= band && x < image.width - band) continue;
      const i = (y * image.width + x) * 4;
      if (image.data[i + 3] < 8) continue;
      r += image.data[i];
      g += image.data[i + 1];
      b += image.data[i + 2];
      n++;
    }
  }
  return n ? [Math.round(r / n), Math.round(g / n), Math.round(b / n)] : [0, 0, 0];
}

/** Draws `image` centred on a `size` square of `background`. */
export function padded(image, size, background) {
  const out = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    out[i * 4] = background[0];
    out[i * 4 + 1] = background[1];
    out[i * 4 + 2] = background[2];
    out[i * 4 + 3] = 255;
  }
  const left = Math.floor((size - image.width) / 2);
  const top = Math.floor((size - image.height) / 2);
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const src = (y * image.width + x) * 4;
      const alpha = image.data[src + 3] / 255;
      if (alpha <= 0) continue;
      const dst = ((top + y) * size + (left + x)) * 4;
      for (let c = 0; c < 3; c++) {
        out[dst + c] = Math.round(image.data[src + c] * alpha + out[dst + c] * (1 - alpha));
      }
      out[dst + 3] = 255;
    }
  }
  return { width: size, height: size, data: out };
}

/** Tiny drawing surface: enough for rectangles, rounded rectangles and circles. */
export class Canvas {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.data = Buffer.alloc(width * height * 4);
  }

  set(x, y, [r, g, b], alpha = 1) {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height || alpha <= 0) return;
    const i = (y * this.width + x) * 4;
    const a = Math.min(1, alpha);
    const src = this.data[i + 3] / 255;
    const out = a + src * (1 - a);
    this.data[i] = (r * a + this.data[i] * src * (1 - a)) / out;
    this.data[i + 1] = (g * a + this.data[i + 1] * src * (1 - a)) / out;
    this.data[i + 2] = (b * a + this.data[i + 2] * src * (1 - a)) / out;
    this.data[i + 3] = out * 255;
  }

  fill(color) {
    for (let y = 0; y < this.height; y++) for (let x = 0; x < this.width; x++) this.set(x, y, color, 1);
  }

  rect(x, y, w, h, color, radius = 0) {
    for (let py = Math.floor(y); py < y + h; py++) {
      for (let px = Math.floor(x); px < x + w; px++) {
        if (radius > 0) {
          const dx = Math.max(x + radius - px - 0.5, px + 0.5 - (x + w - radius), 0);
          const dy = Math.max(y + radius - py - 0.5, py + 0.5 - (y + h - radius), 0);
          const dist = Math.hypot(dx, dy);
          if (dist > radius) continue;
          this.set(px, py, color, Math.min(1, radius - dist + 0.5));
        } else {
          this.set(px, py, color, 1);
        }
      }
    }
  }

  toPng() {
    return encodePng(this.width, this.height, this.data);
  }
}

export const hex = (value) => {
  const n = parseInt(value.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
