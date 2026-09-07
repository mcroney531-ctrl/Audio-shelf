#!/usr/bin/env node
/**
 * Writes a small demo library of silent, correctly tagged MP3s so you can click
 * through AudioShelf before pointing it at your real collection.
 *   npm run seed:demo
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { config } from '../server/config.js';
import { Canvas, hex } from './lib/png.js';

const SAMPLE_RATE = 44100;
const FRAME_SAMPLES = 1152;
const FRAME_BYTES = 417;          // MPEG-1 Layer III, 128 kbps, 44.1 kHz
const FRAME_SECONDS = FRAME_SAMPLES / SAMPLE_RATE;

/** All-zero main data decodes to silence, which is exactly what a demo needs. */
function silentMp3(seconds) {
  const frames = Math.max(1, Math.round(seconds / FRAME_SECONDS));
  const buf = Buffer.alloc(frames * FRAME_BYTES);
  for (let i = 0; i < frames; i++) {
    const at = i * FRAME_BYTES;
    buf[at] = 0xff;
    buf[at + 1] = 0xfb;
    buf[at + 2] = 0x90;   // 128 kbps, 44.1 kHz, no padding
    buf[at + 3] = 0xc0;   // mono
  }
  return buf;
}

const textFrame = (id, value) => {
  let payload;
  if (id === 'COMM') {
    // COMM: encoding, 3-byte language, short description, then the text itself.
    payload = Buffer.concat([
      Buffer.from([0x00]), Buffer.from('eng\0', 'latin1'), Buffer.from(String(value), 'latin1'),
    ]);
  } else if (id.startsWith('TXXX:')) {
    payload = Buffer.concat([
      Buffer.from([0x00]), Buffer.from(`${id.slice(5)}\0`, 'latin1'), Buffer.from(String(value), 'latin1'),
    ]);
    id = 'TXXX';
  } else {
    payload = Buffer.concat([Buffer.from([0x00]), Buffer.from(String(value), 'latin1')]);
  }
  const header = Buffer.alloc(10);
  header.write(id, 0, 'ascii');
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
};

const pictureFrame = (png) => {
  const payload = Buffer.concat([
    Buffer.from([0x00]),
    Buffer.from('image/png\0', 'latin1'),
    Buffer.from([0x03]),                       // front cover
    Buffer.from('cover\0', 'latin1'),
    png,
  ]);
  const header = Buffer.alloc(10);
  header.write('APIC', 0, 'ascii');
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
};

const synchsafe = (size) => Buffer.from([
  (size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f,
]);

function id3(tags, cover) {
  const frames = Object.entries(tags)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([id, value]) => textFrame(id, value));
  if (cover) frames.push(pictureFrame(cover));
  const body = Buffer.concat(frames);
  return Buffer.concat([
    Buffer.from('ID3', 'ascii'), Buffer.from([0x03, 0x00, 0x00]), synchsafe(body.length), body,
  ]);
}

/** A woodcut-ish cover: banded background with a spine mark. */
function coverArt(seedText, palette) {
  const size = 400;
  const canvas = new Canvas(size, size);
  canvas.fill(hex(palette[0]));
  let seed = [...seedText].reduce((acc, ch) => (acc * 31 + ch.charCodeAt(0)) % 9973, 7);
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let i = 0; i < 7; i++) {
    const h = 12 + rand() * 60;
    canvas.rect(0, rand() * size, size, h, hex(palette[1]), 0);
  }
  canvas.rect(size * 0.1, size * 0.1, size * 0.8, size * 0.8, hex(palette[2]), 18);
  canvas.rect(size * 0.16, size * 0.16, size * 0.06, size * 0.68, hex(palette[3]), 8);
  for (let i = 0; i < 5; i++) {
    canvas.rect(size * 0.3, size * 0.26 + i * size * 0.12, size * (0.2 + rand() * 0.35), size * 0.045, hex(palette[3]), 6);
  }
  return canvas.toPng();
}

const BOOKS = [
  {
    author: 'Idris Farrow', title: 'The Cartographer of Small Hours', narrator: 'June Alvarez',
    series: 'Small Hours', seriesIndex: 1, year: 2021, genre: 'Literary Fiction',
    palette: ['#241c17', '#33261d', '#e8b04b', '#171310'],
    description: 'A night-shift mapmaker charts the streets that only exist between 2 and 4 a.m.',
    chapters: ['Prologue: Blue Hour', 'The Ink Ledger', 'North by Lamplight', 'What the River Kept', 'Epilogue: First Light'],
  },
  {
    author: 'Idris Farrow', title: 'A Field Guide to Vanishing', narrator: 'June Alvarez',
    series: 'Small Hours', seriesIndex: 2, year: 2023, genre: 'Literary Fiction',
    palette: ['#1b2220', '#24302c', '#7fb08a', '#111614'],
    description: 'The sequel follows the same mapmaker as the city begins erasing its own corners.',
    chapters: ['The Missing Block', 'Salt and Signal', 'Three Doors', 'Carry the Light'],
  },
  {
    author: 'Wren Okonkwo', title: 'Static Cathedral', narrator: 'Marcus Bell',
    year: 2019, genre: 'Science Fiction',
    palette: ['#1a1620', '#241d30', '#a98bd6', '#12101a'],
    description: 'A radio astronomer hears a hymn in the noise floor and spends a decade proving it is real.',
    chapters: ['Noise Floor', 'The Hymn', 'Interference', 'Choir of One', 'Signal Lost', 'Signal Found'],
  },
  {
    author: 'Hollis Vance', title: 'Salt Roads', narrator: 'Hollis Vance',
    year: 2016, genre: 'History',
    palette: ['#1f1a15', '#2b241c', '#c2603f', '#15110d'],
    description: 'Six hundred years of trade routes told through the people who walked them.',
    chapters: ['Caravan', 'The Long Coast', 'Ledgers and Lies', 'What Salt Bought'],
  },
];

const root = config.libraryDir;
mkdirSync(root, { recursive: true });

for (const book of BOOKS) {
  const dir = path.join(root, book.author, book.title);
  mkdirSync(dir, { recursive: true });
  const cover = coverArt(book.title, book.palette);
  writeFileSync(path.join(dir, 'cover.png'), cover);

  book.chapters.forEach((chapterTitle, index) => {
    const seconds = 45 + (index % 4) * 20;
    const tags = {
      TIT2: chapterTitle,
      TALB: book.title,
      TPE1: book.author,
      TPE2: book.author,
      TCOM: book.narrator,
      TCON: book.genre,
      TYER: book.year,
      TRCK: `${index + 1}/${book.chapters.length}`,
      TIT1: book.series,
      'TXXX:SERIES': book.series,
      'TXXX:SERIES-PART': book.seriesIndex,
      COMM: book.description,
    };
    const file = path.join(dir, `${String(index + 1).padStart(2, '0')} - ${chapterTitle.replace(/[\\/:*?"<>|]/g, '')}.mp3`);
    writeFileSync(file, Buffer.concat([id3(tags, index === 0 ? cover : null), silentMp3(seconds)]));
  });
  console.log(`seeded ${book.author} — ${book.title} (${book.chapters.length} files)`);
}

console.log(`\nDemo library written to ${root}`);
console.log('Next: npm start, then open http://localhost:8080');
