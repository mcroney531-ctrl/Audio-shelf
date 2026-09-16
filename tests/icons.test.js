import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { repoRoot, startTestServer } from './helpers.js';
import { decodePng, encodePng, resize, crop, padded } from '../scripts/lib/png.js';

const icon = (name) => decodePng(readFileSync(path.join(repoRoot, 'web/icons', name)));

describe('the PNG codec', () => {
  // Hand-rolled on top of node:zlib, so it gets its own round trip rather than
  // being trusted because the icons happen to look right.
  test('survives a round trip with alpha', () => {
    const pixels = Buffer.alloc(8 * 8 * 4);
    for (let i = 0; i < 64; i++) {
      pixels[i * 4] = i * 3;
      pixels[i * 4 + 1] = 255 - i * 2;
      pixels[i * 4 + 2] = (i * 7) % 256;
      pixels[i * 4 + 3] = i % 5 === 0 ? 128 : 255;   // forces the RGBA path
    }
    const decoded = decodePng(encodePng(8, 8, pixels));
    assert.equal(decoded.width, 8);
    assert.deepEqual([...decoded.data], [...pixels]);
  });

  test('survives a round trip with no alpha, via the smaller RGB path', () => {
    const pixels = Buffer.alloc(16 * 16 * 4);
    for (let i = 0; i < 256; i++) {
      pixels[i * 4] = i;
      pixels[i * 4 + 1] = (i * 5) % 256;
      pixels[i * 4 + 2] = 255 - i;
      pixels[i * 4 + 3] = 255;
    }
    const encoded = encodePng(16, 16, pixels);
    assert.equal(encoded[25], 2, 'a fully opaque image should be written as RGB, not RGBA');
    assert.deepEqual([...decodePng(encoded).data], [...pixels]);
  });

  test('resizing averages rather than sampling', () => {
    // A 2x2 of pure red, green, blue and white averages to one grey-ish pixel.
    const source = { width: 2, height: 2, data: Buffer.from([
      255, 0, 0, 255, 0, 255, 0, 255,
      0, 0, 255, 255, 255, 255, 255, 255,
    ]) };
    const small = resize(source, 1, 1);
    assert.deepEqual([...small.data], [128, 128, 128, 255]);
  });

  test('padding centres the art and fills the rest', () => {
    const art = { width: 2, height: 2, data: Buffer.alloc(16, 255) };
    const out = padded(art, 4, [10, 20, 30]);
    assert.deepEqual([...out.data.subarray(0, 4)], [10, 20, 30, 255], 'corner should be background');
    const middle = (1 * 4 + 1) * 4;
    assert.deepEqual([...out.data.subarray(middle, middle + 4)], [255, 255, 255, 255]);
  });

  test('cropping stays inside the image even when asked not to', () => {
    const source = { width: 10, height: 10, data: Buffer.alloc(400, 7) };
    for (const [x, y] of [[0, 0], [1, 1], [0.5, 0.5], [-1, 2]]) {
      const out = crop(source, x, y, 0.5);
      assert.equal(out.width, 5);
      assert.equal(out.data.length, 5 * 5 * 4);
    }
  });
});

describe('the generated icon set', () => {
  test('every icon is the size its filename claims', () => {
    for (const [name, size] of [
      ['icon-192.png', 192], ['icon-512.png', 512],
      ['icon-maskable-192.png', 192], ['icon-maskable-512.png', 512],
      ['apple-touch-icon.png', 180], ['favicon-32.png', 32],
    ]) {
      const image = icon(name);
      assert.equal(image.width, size, `${name} width`);
      assert.equal(image.height, size, `${name} height`);
    }
  });

  test('maskable icons keep their corners inside the safe zone', () => {
    // Android's mask can crop to a circle of 80% diameter. The corner pixels
    // must therefore be padding, not artwork - if the logo runs to the edge
    // of a maskable asset, the install silently eats part of the mark.
    const maskable = icon('icon-maskable-512.png');
    const plain = icon('icon-512.png');
    const corner = (image) => [...image.data.subarray(0, 3)];
    const centre = (image) => {
      const at = ((image.height / 2) * image.width + image.width / 2) * 4;
      return [...image.data.subarray(at, at + 3)];
    };
    assert.notDeepEqual(corner(maskable), corner(plain),
      'the maskable corner should be padding, not the same artwork as the plain icon');
    assert.deepEqual(centre(maskable).length, 3);
    // Padding is a flat colour, so opposite corners match each other.
    const topRight = [...maskable.data.subarray((511 * 4), (511 * 4) + 3)];
    assert.deepEqual(corner(maskable), topRight, 'padding should be uniform');
  });

  test('the manifest never combines any and maskable in one entry', () => {
    const manifest = JSON.parse(readFileSync(path.join(repoRoot, 'web/manifest.json'), 'utf8'));
    for (const entry of manifest.icons) {
      assert.ok(!/\s/.test(entry.purpose.trim()),
        `"purpose": "${entry.purpose}" combines purposes, which trips Chrome's WebAPK icon resolution`);
    }
    for (const purpose of ['any', 'maskable']) {
      for (const size of ['192x192', '512x512']) {
        assert.ok(
          manifest.icons.some((entry) => entry.purpose === purpose && entry.sizes === size),
          `manifest needs a ${size} icon with purpose ${purpose}`,
        );
      }
    }
  });
});

describe('how icons are cached', () => {
  let server;

  before(async () => { server = await startTestServer({ seed: false, scan: false }); });
  after(async () => { await server?.stop(); });

  test('icons revalidate instead of being frozen in the browser cache', async () => {
    // A new logo rewrites every icon under the same filename. Serving those
    // with a long max-age means a phone keeps the old set even after the app
    // is uninstalled and reinstalled - the HTTP cache belongs to the browser,
    // not to the installed PWA - and no service-worker version bump can help,
    // because cache.addAll() reads through that same cache.
    for (const name of ['icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'favicon-32.png']) {
      const response = await server.call(`/icons/${name}`);
      assert.equal(response.status, 200, name);
      const control = response.headers.get('cache-control') || '';
      assert.ok(!/max-age=[1-9]/.test(control),
        `${name} is served "${control}" — a nonzero max-age freezes a stale icon on every device`);
      assert.ok(response.headers.get('etag'), `${name} needs an ETag to revalidate against`);
    }
  });

  test('an unchanged icon still costs only a 304', async () => {
    const first = await server.call('/icons/icon-512.png');
    const second = await server.call('/icons/icon-512.png', {
      headers: { 'if-none-match': first.headers.get('etag') },
    });
    assert.equal(second.status, 304);
  });

  test('fonts stay immutable — those really never change', async () => {
    const response = await server.call('/fonts/karla-latin.woff2');
    assert.match(response.headers.get('cache-control') || '', /max-age=\d{4,}/);
  });

  test('the service worker fetches its shell past the HTTP cache', async () => {
    const sw = readFileSync(path.join(repoRoot, 'web/sw.js'), 'utf8');
    assert.match(sw, /cache:\s*'reload'/,
      "install must fetch with cache: 'reload', or a version bump can re-cache the same stale files");
  });
});
