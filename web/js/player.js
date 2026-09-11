import { api, coverUrl, trackUrl } from './api.js';

const PENDING_KEY = 'audioshelf.pendingProgress';
const SPEED_KEY = 'audioshelf.speed';
const LAST_KEY = 'audioshelf.lastBook';
const SAVE_EVERY_MS = 12_000;

const readPending = () => {
  try { return JSON.parse(localStorage.getItem(PENDING_KEY) || '{}'); } catch { return {}; }
};
const writePending = (value) => {
  try { localStorage.setItem(PENDING_KEY, JSON.stringify(value)); } catch { /* private mode */ }
};

/**
 * Owns the single <audio> element and everything time-shaped: which track is
 * loaded, where we are in the book as a whole, chapters, speed, sleep timer,
 * and pushing listening position back to the server (or queueing it offline).
 */
export class Player extends EventTarget {
  constructor(audio) {
    super();
    this.audio = audio;
    this.book = null;
    this.trackIndex = 0;
    this.speed = Number(localStorage.getItem(SPEED_KEY)) || 1;
    this.sleep = null;          // { until, mode, timer }
    this.lastSaved = 0;
    this.pendingSeek = null;

    audio.addEventListener('timeupdate', () => {
      this.emit('tick');
      if (this.playing && Date.now() - this.lastSaved > SAVE_EVERY_MS) this.save();
    });
    audio.addEventListener('play', () => { this.emit('state'); this.updateSessionState(); });
    audio.addEventListener('pause', () => { this.emit('state'); this.save(); });
    audio.addEventListener('ended', () => this.onTrackEnded());
    audio.addEventListener('loadedmetadata', () => {
      if (this.pendingSeek !== null) {
        audio.currentTime = this.pendingSeek;
        this.pendingSeek = null;
      }
      audio.playbackRate = this.speed;
      this.emit('tick');
    });
    audio.addEventListener('error', () => {
      if (!this.book) return;
      const where = this.track ? ` (${this.track.title})` : '';
      this.emit('error', {
        message: navigator.onLine
          ? `That file would not play${where}. Is the library still mounted?`
          : `Not available offline${where} — download the book while connected`,
      });
    });
    audio.addEventListener('ratechange', () => this.emit('state'));

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.save({ beacon: true });
    });
    window.addEventListener('pagehide', () => this.save({ beacon: true }));
    window.addEventListener('online', () => this.flushPending());
    this.flushPending();
    this.bindMediaSession();
  }

  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  // --- position maths ------------------------------------------------------
  get track() { return this.book?.tracks[this.trackIndex] || null; }
  get playing() { return !this.audio.paused && !this.audio.ended; }
  get duration() { return this.book?.duration || 0; }

  get position() {
    if (!this.track) return 0;
    return this.track.start + (this.audio.currentTime || 0);
  }

  trackIndexAt(position) {
    if (!this.book) return 0;
    const tracks = this.book.tracks;
    for (let i = tracks.length - 1; i >= 0; i--) {
      if (position >= tracks[i].start - 0.001) return i;
    }
    return 0;
  }

  get chapter() {
    const chapters = this.book?.chapters || [];
    const position = this.position;
    for (let i = chapters.length - 1; i >= 0; i--) {
      if (position >= chapters[i].start - 0.001) return { ...chapters[i], number: i + 1, of: chapters.length };
    }
    return chapters.length ? { ...chapters[0], number: 1, of: chapters.length } : null;
  }

  // --- loading -------------------------------------------------------------
  async open(book, { position = null, autoplay = true } = {}) {
    const sameBook = this.book?.id === book.id;
    this.book = book;
    const target = position ?? book.progress?.position ?? 0;
    if (book.progress?.speed) this.setSpeed(book.progress.speed, { persist: false });
    try { localStorage.setItem(LAST_KEY, String(book.id)); } catch { /* ignore */ }

    if (!sameBook || this.trackIndexAt(target) !== this.trackIndex) {
      this.loadTrack(this.trackIndexAt(target), target - (book.tracks[this.trackIndexAt(target)]?.start || 0));
    } else {
      this.audio.currentTime = target - this.track.start;
    }
    this.emit('change');
    this.updateSessionMetadata();
    if (autoplay) await this.play();
  }

  loadTrack(index, offset = 0) {
    const track = this.book?.tracks[index];
    if (!track) return;
    this.trackIndex = index;
    this.pendingSeek = Math.max(0, offset);
    this.audio.src = trackUrl(track.id);
    this.audio.load();
    this.emit('change');
  }

  async play() {
    try {
      await this.audio.play();
    } catch (err) {
      // AbortError just means another load superseded this one.
      if (err.name === 'AbortError') return;
      if (err.name === 'NotAllowedError') {
        return this.emit('error', { message: 'The browser blocked autoplay - press play' });
      }
      const where = this.track ? ` (${this.track.title})` : '';
      this.emit('error', {
        message: navigator.onLine
          ? `Could not play this file${where}`
          : `Not available offline${where} - download the book while connected`,
      });
    }
  }

  toggle() {
    if (!this.book) return;
    if (this.playing) this.audio.pause(); else this.play();
  }

  seekTo(position) {
    if (!this.book) return;
    const clamped = Math.max(0, Math.min(position, this.duration - 0.5));
    const index = this.trackIndexAt(clamped);
    const offset = clamped - this.book.tracks[index].start;
    if (index === this.trackIndex) {
      this.audio.currentTime = offset;
    } else {
      const wasPlaying = this.playing;
      this.loadTrack(index, offset);
      if (wasPlaying) this.play();
    }
    this.emit('tick');
    this.save();
  }

  skip(delta) { this.seekTo(this.position + delta); }

  nextChapter(direction = 1) {
    const chapters = this.book?.chapters || [];
    if (!chapters.length) return this.skip(direction * 300);
    const current = this.chapter?.number ?? 1;
    if (direction < 0 && this.position - chapters[current - 1].start > 3) {
      return this.seekTo(chapters[current - 1].start);
    }
    const target = chapters[current - 1 + direction];
    this.seekTo(target ? target.start : direction > 0 ? this.duration - 1 : 0);
  }

  onTrackEnded() {
    if (this.sleep?.mode === 'chapter') return this.stopSleep({ pause: true });
    if (this.trackIndex + 1 < (this.book?.tracks.length || 0)) {
      this.loadTrack(this.trackIndex + 1, 0);
      this.play();
    } else {
      this.save({ finished: true });
      this.emit('state');
      this.emit('finished');
    }
  }

  setSpeed(speed, { persist = true } = {}) {
    this.speed = Math.min(Math.max(Number(speed) || 1, 0.5), 4);
    this.audio.playbackRate = this.speed;
    if (persist) {
      try { localStorage.setItem(SPEED_KEY, String(this.speed)); } catch { /* ignore */ }
      this.save();
    }
    this.emit('state');
  }

  // --- sleep timer ---------------------------------------------------------
  setSleep(minutes) {
    this.clearSleepTimer();
    if (minutes === 'chapter') {
      const chapter = this.chapter;
      this.sleep = { mode: 'chapter', until: chapter ? Date.now() + ((chapter.end - this.position) / this.speed) * 1000 : null };
      if (chapter) this.sleep.timer = setTimeout(() => this.fadeOut(), Math.max(0, (chapter.end - this.position) / this.speed) * 1000 - 15000);
    } else if (minutes) {
      const ms = minutes * 60_000;
      this.sleep = { mode: 'timer', until: Date.now() + ms };
      this.sleep.timer = setTimeout(() => this.fadeOut(), Math.max(0, ms - 15_000));
    } else {
      this.sleep = null;
    }
    this.emit('state');
  }

  clearSleepTimer() {
    if (this.sleep?.timer) clearTimeout(this.sleep.timer);
    if (this.sleep?.fade) clearInterval(this.sleep.fade);
  }

  /** Ease the volume down over the last 15 seconds so it does not cut off mid-word. */
  fadeOut() {
    if (!this.sleep) return;
    const startVolume = this.audio.volume;
    const started = Date.now();
    this.sleep.fade = setInterval(() => {
      const ratio = Math.min(1, (Date.now() - started) / 15_000);
      this.audio.volume = startVolume * (1 - ratio);
      if (ratio >= 1) this.stopSleep({ pause: true, restore: startVolume });
    }, 250);
  }

  stopSleep({ pause = false, restore = 1 } = {}) {
    this.clearSleepTimer();
    this.sleep = null;
    if (pause) {
      this.audio.pause();
      this.audio.volume = restore;
      this.emit('sleep-finished');
    }
    this.emit('state');
  }

  // --- persistence ---------------------------------------------------------
  save({ beacon = false, finished } = {}) {
    if (!this.book || !this.track) return;
    const payload = {
      position: Math.round(this.position * 10) / 10,
      speed: this.speed,
      ...(finished === undefined ? {} : { finished }),
    };
    this.lastSaved = Date.now();
    if (this.book.progress) Object.assign(this.book.progress, payload);
    else this.book.progress = { ...payload, finished: !!finished, updatedAt: Date.now() };
    this.emit('saved', { bookId: this.book.id, ...payload });

    const url = `/api/books/${this.book.id}/progress`;
    if (beacon && navigator.sendBeacon) {
      const ok = navigator.sendBeacon(url, new Blob([JSON.stringify(payload)], { type: 'application/json' }));
      if (!ok) this.queue(this.book.id, payload);
      return;
    }
    api.saveProgress(this.book.id, payload).catch(() => this.queue(this.book.id, payload));
  }

  queue(bookId, payload) {
    const pending = readPending();
    pending[bookId] = { ...payload, queuedAt: Date.now() };
    writePending(pending);
  }

  async flushPending() {
    const pending = readPending();
    const ids = Object.keys(pending);
    if (!ids.length) return;
    for (const id of ids) {
      try {
        const { queuedAt, ...payload } = pending[id];
        await api.saveProgress(id, payload);
        delete pending[id];
      } catch { break; }
    }
    writePending(pending);
    if (!Object.keys(pending).length) this.emit('synced');
  }

  // --- OS integration ------------------------------------------------------
  bindMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const handlers = {
      play: () => this.play(),
      pause: () => this.audio.pause(),
      seekbackward: () => this.skip(-15),
      seekforward: () => this.skip(30),
      previoustrack: () => this.nextChapter(-1),
      nexttrack: () => this.nextChapter(1),
      stop: () => { this.audio.pause(); this.save(); },
      seekto: (details) => { if (details.seekTime !== undefined) this.seekTo(details.seekTime); },
    };
    for (const [action, handler] of Object.entries(handlers)) {
      try { navigator.mediaSession.setActionHandler(action, handler); } catch { /* unsupported action */ }
    }
  }

  updateSessionMetadata() {
    if (!('mediaSession' in navigator) || !this.book) return;
    const cover = coverUrl(this.book);
    navigator.mediaSession.metadata = new MediaMetadata({
      title: this.chapter?.title || this.book.title,
      artist: this.book.author || 'Unknown author',
      album: this.book.title,
      artwork: cover ? [{ src: cover, sizes: '512x512', type: 'image/jpeg' }] : [],
    });
  }

  updateSessionState() {
    if (!('mediaSession' in navigator) || !this.book) return;
    try {
      navigator.mediaSession.setPositionState({
        duration: this.duration || 0,
        position: Math.min(this.position, this.duration || 0),
        playbackRate: this.speed,
      });
    } catch { /* Safari throws on odd values */ }
  }
}

export const lastBookId = () => Number(localStorage.getItem(LAST_KEY)) || null;
