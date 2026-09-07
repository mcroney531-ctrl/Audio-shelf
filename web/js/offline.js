import { coverUrl, trackUrl } from './api.js';

export const MEDIA_CACHE = 'audioshelf-media-v1';
const INDEX_KEY = 'audioshelf.downloads';

const readIndex = () => {
  try { return JSON.parse(localStorage.getItem(INDEX_KEY) || '{}'); } catch { return {}; }
};
const writeIndex = (value) => {
  try { localStorage.setItem(INDEX_KEY, JSON.stringify(value)); } catch { /* ignore */ }
};

export const downloadIndex = () => readIndex();
export const isDownloaded = (bookId) => Boolean(readIndex()[bookId]);

export async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return null;
  try {
    const registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    // A fresh worker means new app code; take it on the next load rather than mid-session.
    registration.addEventListener('updatefound', () => {
      const worker = registration.installing;
      worker?.addEventListener('statechange', () => {
        if (worker.state === 'installed' && navigator.serviceWorker.controller) {
          document.dispatchEvent(new CustomEvent('audioshelf:update-ready'));
        }
      });
    });
    return registration;
  } catch (err) {
    console.warn('Service worker registration failed', err);
    return null;
  }
}

/**
 * Pulls every track (and the cover) of a book into the media cache so the book
 * plays with the network unplugged. Reports track-level progress.
 */
export async function downloadBook(book, onProgress = () => {}) {
  if (!('caches' in window)) throw new Error('This browser cannot store downloads');
  const cache = await caches.open(MEDIA_CACHE);
  const urls = book.tracks.map((track) => trackUrl(track.id));
  const cover = coverUrl(book);
  if (cover) urls.push(cover);

  let bytes = 0;
  for (const [index, url] of urls.entries()) {
    onProgress({ done: index, total: urls.length, url });
    const response = await fetch(url, { credentials: 'same-origin' });
    if (!response.ok) throw new Error(`Could not download ${url}`);
    bytes += Number(response.headers.get('content-length')) || 0;
    await cache.put(url, response);
  }
  onProgress({ done: urls.length, total: urls.length });

  const index = readIndex();
  index[book.id] = {
    id: book.id,
    title: book.title,
    author: book.author,
    urls,
    bytes: bytes || book.size || 0,
    savedAt: Date.now(),
  };
  writeIndex(index);
  return index[book.id];
}

export async function removeDownload(bookId) {
  const index = readIndex();
  const entry = index[bookId];
  if (!entry) return;
  if ('caches' in window) {
    const cache = await caches.open(MEDIA_CACHE);
    await Promise.all(entry.urls.map((url) => cache.delete(url)));
  }
  delete index[bookId];
  writeIndex(index);
}

export async function clearAllDownloads() {
  if ('caches' in window) await caches.delete(MEDIA_CACHE);
  writeIndex({});
}

export async function storageUsage() {
  const entries = Object.values(readIndex());
  const local = entries.reduce((sum, entry) => sum + (entry.bytes || 0), 0);
  let quota = null;
  if (navigator.storage?.estimate) {
    try {
      const estimate = await navigator.storage.estimate();
      quota = { usage: estimate.usage, quota: estimate.quota };
    } catch { /* ignore */ }
  }
  return { books: entries.length, bytes: local, quota };
}

/** Ask the browser to keep our cache when disk gets tight. */
export async function requestPersistence() {
  if (!navigator.storage?.persist) return false;
  try {
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch { return false; }
}

export const formatBytes = (bytes) => {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let scaled = value / 1024;
  let unit = 0;
  while (scaled >= 1024 && unit < units.length - 1) { scaled /= 1024; unit++; }
  return `${scaled.toFixed(scaled >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
};
