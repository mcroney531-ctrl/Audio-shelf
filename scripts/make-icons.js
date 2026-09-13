#!/usr/bin/env node
/**
 * Generates the PWA icon set from assets/logo.png.
 *
 * Run with `npm run icons` after replacing the logo. Everything is done with
 * node:zlib and the little PNG codec in lib/, so regenerating icons never
 * needs ImageMagick, sharp, or a design tool installed.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePng, encodePng, resize, squareCrop, crop, edgeColor, padded } from './lib/png.js';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const outDir = path.join(root, 'web/icons');
const source = path.join(root, 'assets/logo.png');
mkdirSync(outDir, { recursive: true });

const logo = squareCrop(decodePng(readFileSync(source)));
console.log(`source: assets/logo.png (${logo.width}x${logo.height})`);

// Android's adaptive-icon mask can crop anything outside the inner ~80%, and
// this logo's frame runs right to its own edge. Shrinking it into the safe
// zone over a colour lifted from its border keeps the whole mark visible
// without a visible seam where the padding starts.
const background = edgeColor(logo);
console.log(`maskable padding: rgb(${background.join(', ')})`);

/**
 * At 32px the whole logo is an indistinct brown square - a shelf, a lamp and a
 * houseplant cannot survive that reduction. The tab icon is instead the
 * headphones-and-waveform emblem from the front of the green book: part of the
 * same artwork, and a simple enough shape to still read at a third of an inch.
 */
const EMBLEM = { x: 0.513, y: 0.42, size: 0.24 };

/**
 * Android WebAPK installs need SEPARATE `any` and `maskable` entries in the
 * manifest, each backed by its own asset: a combined "any maskable" purpose
 * trips a Chrome icon-resolution bug and quietly falls back to a bookmark
 * shortcut rather than a real installed app.
 */
const targets = [
  ['icon-192.png', 192, 1, null],
  ['icon-512.png', 512, 1, null],
  ['icon-maskable-192.png', 192, 0.8, null],
  ['icon-maskable-512.png', 512, 0.8, null],
  ['apple-touch-icon.png', 180, 1, null],   // iOS rounds the corners itself
  ['favicon-32.png', 32, 1, EMBLEM],
];

for (const [name, size, scale, region] of targets) {
  const art = region ? crop(logo, region.x, region.y, region.size) : logo;
  const inner = Math.round(size * scale);
  const scaled = resize(art, inner, inner);
  const image = scale === 1 ? scaled : padded(scaled, size, background);
  writeFileSync(path.join(outDir, name), encodePng(image.width, image.height, image.data));
  console.log(`wrote web/icons/${name} (${size}px`
    + `${scale === 1 ? '' : `, art at ${inner}px`}${region ? ', emblem crop' : ''})`);
}
