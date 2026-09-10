import { watch } from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { scanLibrary, scanState } from './scanner.js';

/**
 * Watches the library folders so books added in Explorer/Finder show up on the
 * shelf on their own. Events are debounced: copying a 500 MB audiobook fires
 * hundreds of them, and scanning a half-copied file is a waste of time.
 */
const INTERESTING = /\.(mp3|m4b|m4a|mp4|aac|ogg|oga|opus|flac|wav|webm|aax|aaxc|voucher|jpg|jpeg|png|webp)$/i;

export const watchState = {
  active: false,
  roots: [],
  pending: false,
  lastTriggeredAt: null,
  error: null,
};

export function watchLibrary({ delayMs = config.watchDelaySec * 1000 } = {}) {
  const watchers = [];
  let timer = null;

  const queue = () => {
    watchState.pending = true;
    clearTimeout(timer);
    timer = setTimeout(rescan, delayMs);
    timer.unref?.();
  };

  async function rescan() {
    if (scanState.running) return queue();   // try again once the current scan ends
    watchState.pending = false;
    watchState.lastTriggeredAt = Date.now();
    await scanLibrary();
    if (scanState.added || scanState.updated || scanState.removed) {
      console.log(`[watch] +${scanState.added} added, ${scanState.updated} updated, ${scanState.removed} removed`);
    }
  }

  for (const root of config.libraryRoots) {
    try {
      const watcher = watch(root, { recursive: true, persistent: false }, (event, filename) => {
        if (!filename) return queue();
        // Ignore our own in-progress conversions and unrelated files.
        if (filename.endsWith('.part')) return;
        if (path.extname(filename) && !INTERESTING.test(filename)) return;
        queue();
      });
      watcher.on('error', (err) => {
        watchState.error = err.message;
        console.warn(`[watch] stopped watching ${root}: ${err.message}`);
      });
      watchers.push(watcher);
      watchState.roots.push(root);
    } catch (err) {
      // Recursive watching is not available everywhere (some network shares,
      // older platforms). The periodic scan is the fallback.
      watchState.error = err.message;
      console.warn(`[watch] cannot watch ${root} (${err.message}) - set AUDIOSHELF_SCAN_INTERVAL_MIN instead`);
    }
  }

  watchState.active = watchers.length > 0;
  if (watchState.active) {
    console.log(`[watch] watching ${watchers.length} folder${watchers.length === 1 ? '' : 's'} for new books`);
  }

  return {
    close() {
      clearTimeout(timer);
      for (const watcher of watchers) watcher.close();
      watchState.active = false;
    },
  };
}
