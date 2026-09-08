#!/usr/bin/env node
/** Generates the PWA icon set. Run with `npm run icons` after tweaking colours. */
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Canvas, hex } from './lib/png.js';

const outDir = path.resolve(fileURLToPath(new URL('../web/icons', import.meta.url)));
mkdirSync(outDir, { recursive: true });

const INK = hex('#171310');
const AMBER = hex('#e8b04b');
const RUST = hex('#c2603f');
const CREAM = hex('#f6ecd9');

/** A stack of shelved spines with a listening pulse running through them. */
function draw(size, { padding = 0.12 } = {}) {
  const canvas = new Canvas(size, size);
  canvas.fill(INK);

  const pad = size * padding;
  const inner = size - pad * 2;
  const spines = [
    { w: 0.13, h: 0.72, color: CREAM },
    { w: 0.10, h: 0.86, color: RUST },
    { w: 0.155, h: 0.62, color: AMBER },
    { w: 0.10, h: 0.94, color: CREAM },
    { w: 0.13, h: 0.78, color: AMBER },
  ];
  const gap = 0.035 * inner;
  const totalWidth = spines.reduce((sum, spine) => sum + spine.w * inner, 0) + gap * (spines.length - 1);
  let x = pad + (inner - totalWidth) / 2;
  const baseline = pad + inner;

  for (const spine of spines) {
    const w = spine.w * inner;
    const h = spine.h * inner;
    canvas.rect(x, baseline - h, w, h, spine.color, Math.min(w, h) * 0.22);
    x += w + gap;
  }

  // The pulse: a horizontal band cutting across the spines.
  const bandHeight = Math.max(2, inner * 0.055);
  canvas.rect(pad, baseline - inner * 0.46, inner, bandHeight, INK, bandHeight / 2);
  canvas.rect(pad + inner * 0.06, baseline - inner * 0.45, inner * 0.88, bandHeight * 0.55, AMBER, bandHeight * 0.3);
  return canvas;
}

/**
 * Android WebAPK installs need SEPARATE `any` and `maskable` entries in the
 * manifest, each backed by its own asset: a combined "any maskable" purpose
 * trips a Chrome icon-resolution bug and quietly falls back to a bookmark
 * shortcut. Maskable art is drawn into the inner ~80% safe zone so Android's
 * adaptive-icon mask cannot crop the mark.
 */
const targets = [
  ['icon-192.png', 192, 0.14],
  ['icon-512.png', 512, 0.14],
  ['icon-maskable-192.png', 192, 0.26],
  ['icon-maskable-512.png', 512, 0.26],
  ['apple-touch-icon.png', 180, 0.16],
  ['favicon-32.png', 32, 0.10],
];

for (const [name, size, padding] of targets) {
  writeFileSync(path.join(outDir, name), draw(size, { padding }).toPng());
  console.log(`wrote web/icons/${name} (${size}px)`);
}
