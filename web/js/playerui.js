import { h, icon, mount, clockTime, humanDuration, toast } from './dom.js';
import { api, coverUrl } from './api.js';
import { coverNode } from './views.js';

const SPEEDS = [0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];
const SLEEPS = [
  [null, 'Off'], [5, '5 min'], [10, '10 min'], [15, '15 min'],
  [30, '30 min'], [45, '45 min'], [60, '60 min'], ['chapter', 'End of chapter'],
];

/** The dock (mini player) and the full-screen now-playing sheet. */
export function createPlayerUI(player, ctx) {
  // --- dock ---------------------------------------------------------------
  const dockFill = h('i');
  const dockLine = h('div.dock__line', {
    title: 'Seek',
    onclick: (event) => {
      const rect = event.currentTarget.getBoundingClientRect();
      player.seekTo(((event.clientX - rect.left) / rect.width) * player.duration);
    },
  }, dockFill);

  const dockArt = h('div.dock__art');
  const dockTitle = h('div.dock__title');
  const dockSub = h('div.dock__sub');
  const dockPlay = h('button.iconbtn.iconbtn--play', { title: 'Play or pause', onclick: () => player.toggle() }, icon('play'));

  const dock = h('div.dock', dockLine, h('div.dock__body',
    h('button', { style: { display: 'contents' }, title: 'Open player', onclick: openPlayer }, dockArt),
    h('button', {
      style: { textAlign: 'left', minWidth: 0, overflow: 'hidden' },
      title: 'Open player',
      onclick: openPlayer,
    }, dockTitle, dockSub),
    h('div.dock__controls',
      h('button.iconbtn.skipbtn', { title: 'Back 15 seconds', onclick: () => player.skip(-15) }, icon('back15'), h('span', '15')),
      dockPlay,
      h('button.iconbtn.skipbtn', { title: 'Forward 30 seconds', onclick: () => player.skip(30) }, icon('fwd30'), h('span', '30')))));

  // --- full player --------------------------------------------------------
  const art = h('div.player__art');
  const title = h('h1.player__title');
  const sub = h('p.player__sub');
  const chapterLine = h('p.tag');

  const scrub = h('input', {
    type: 'range', min: 0, max: 1000, value: 0, 'aria-label': 'Seek',
    oninput: (event) => {
      scrubbing = true;
      elapsed.textContent = clockTime((event.target.value / 1000) * player.duration);
      event.target.style.setProperty('--pct', `${event.target.value / 10}%`);
    },
    onchange: (event) => {
      scrubbing = false;
      player.seekTo((event.target.value / 1000) * player.duration);
    },
  });
  let scrubbing = false;
  const elapsed = h('span', '0:00');
  const remaining = h('span', '-0:00');

  const bigPlay = h('button.iconbtn.iconbtn--play', { title: 'Play or pause', onclick: () => player.toggle() }, icon('play'));
  const speedBtn = h('button.chip', { onclick: () => switchTab('speed') }, '1×');
  const sleepBtn = h('button.chip', { onclick: () => switchTab('sleep') }, icon('clock', 14), 'Sleep');

  const bookmarkBtn = h('button.chip', {
    onclick: async () => {
      if (!player.book) return;
      const note = prompt('Bookmark note (optional)', player.chapter?.title || '') ?? null;
      if (note === null) return;
      await api.addBookmark(player.book.id, { position: player.position, note });
      toast(`Bookmarked at ${clockTime(player.position)}`);
    },
  }, icon('bookmark', 14), 'Bookmark');

  const panel = h('div.panel');
  const tabs = h('div.tabs');
  let activeTab = 'chapters';

  const player_ = h('div.player', { role: 'dialog', 'aria-label': 'Now playing' },
    h('div.player__head',
      h('button.iconbtn', { title: 'Close player', onclick: closePlayer }, icon('chevronDown')),
      h('p.eyebrow', 'Now playing'),
      h('a.iconbtn', { title: 'Book details', href: '#', onclick: (e) => { e.preventDefault(); if (player.book) { closePlayer(); location.hash = `#/book/${player.book.id}`; } } }, icon('list'))),
    h('div.player__body',
      h('div.player__stage',
        art,
        h('div', title, sub, chapterLine),
        h('div.scrub', scrub, h('div.scrub__times', elapsed, remaining)),
        h('div.transport',
          h('button.iconbtn', { title: 'Previous chapter', onclick: () => player.nextChapter(-1) }, icon('prev')),
          h('button.iconbtn.skipbtn', { title: 'Back 15 seconds', onclick: () => player.skip(-15) }, icon('back15'), h('span', '15')),
          bigPlay,
          h('button.iconbtn.skipbtn', { title: 'Forward 30 seconds', onclick: () => player.skip(30) }, icon('fwd30'), h('span', '30')),
          h('button.iconbtn', { title: 'Next chapter', onclick: () => player.nextChapter(1) }, icon('next'))),
        h('div.chips', { style: { justifyContent: 'center' } }, speedBtn, sleepBtn, bookmarkBtn)),
      h('div.player__aside', tabs, panel)));

  function switchTab(name) {
    activeTab = name;
    renderTabs();
  }

  function renderTabs() {
    mount(tabs, ...[['chapters', 'Chapters'], ['speed', 'Speed'], ['sleep', 'Sleep timer']].map(([key, label]) =>
      h('button.tab', { 'aria-selected': String(activeTab === key), onclick: () => switchTab(key) }, label)));
    renderPanel();
  }

  function renderPanel() {
    if (!player.book) return mount(panel, h('p.tag', 'Nothing playing yet.'));

    if (activeTab === 'chapters') {
      const entries = player.book.chapters.length ? player.book.chapters : player.book.tracks;
      const current = player.chapter?.number ?? player.trackIndex + 1;
      return mount(panel, h('div.list', ...entries.map((entry, index) => h('button.list__row', {
        'aria-current': String(index + 1 === current),
        onclick: () => player.seekTo(entry.start),
      },
        h('span.list__num', String(index + 1).padStart(2, '0')),
        h('span.list__name', entry.title),
        h('span.list__time', clockTime(entry.start))))));
    }

    if (activeTab === 'speed') {
      return mount(panel,
        h('p.tag', { style: { marginBottom: '12px' } }, 'Narration speed for this book'),
        h('div.speeddial', ...SPEEDS.map((speed) => h('button.chip', {
          'aria-pressed': String(Math.abs(player.speed - speed) < 0.001),
          onclick: () => { player.setSpeed(speed); renderPanel(); },
        }, `${speed}×`))),
        h('p.tag', { style: { marginTop: '16px' } },
          `Finishes in ${humanDuration((player.duration - player.position) / player.speed)} at this speed`));
    }

    return mount(panel,
      h('p.tag', { style: { marginBottom: '12px' } }, 'Fades out over the last 15 seconds'),
      h('div.speeddial', ...SLEEPS.map(([value, label]) => h('button.chip', {
        'aria-pressed': String((player.sleep?.mode === 'chapter' && value === 'chapter')
          || (!player.sleep && value === null)),
        onclick: () => { player.setSleep(value); renderPanel(); },
      }, label))),
      player.sleep?.until
        ? h('p.tag', { style: { marginTop: '14px' } },
          `Sleeping in ${clockTime(Math.max(0, (player.sleep.until - Date.now()) / 1000))}`)
        : null);
  }

  function openPlayer() {
    if (!player.book) return;
    player_.classList.add('player--open');
    document.body.style.overflow = 'hidden';
    renderTabs();
  }
  function closePlayer() {
    player_.classList.remove('player--open');
    document.body.style.overflow = '';
  }

  // --- syncing ------------------------------------------------------------
  function renderMeta() {
    const book = player.book;
    if (!book) return;
    dock.classList.add('dock--open');
    mount(dockArt, coverNode(book));
    mount(art, coverNode(book, { eager: true }));
    dockTitle.textContent = book.title;
    title.textContent = book.title;
    sub.textContent = [book.author, book.narrator && `read by ${book.narrator}`].filter(Boolean).join(' · ');
    renderTabs();
  }

  function renderTick() {
    const position = player.position;
    const duration = player.duration || 1;
    const pct = Math.min(100, (position / duration) * 100);
    dockFill.style.width = `${pct}%`;
    if (!scrubbing) {
      scrub.value = String(Math.round((position / duration) * 1000));
      scrub.style.setProperty('--pct', `${pct}%`);
      elapsed.textContent = clockTime(position);
      remaining.textContent = `-${clockTime((duration - position) / player.speed)}`;
    }
    const chapter = player.chapter;
    dockSub.textContent = chapter
      ? `${chapter.title} · ${clockTime(position)}`
      : `${player.book?.author || ''} · ${clockTime(position)}`;
    chapterLine.textContent = chapter
      ? `Chapter ${chapter.number} of ${chapter.of} · ${chapter.title}`
      : `${clockTime(position)} of ${clockTime(duration)}`;
    if (activeTab === 'chapters' && player_.classList.contains('player--open')) {
      const rows = panel.querySelectorAll('.list__row');
      const current = (chapter?.number ?? player.trackIndex + 1) - 1;
      rows.forEach((row, index) => row.setAttribute('aria-current', String(index === current)));
    }
  }

  function renderState() {
    const playing = player.playing;
    mount(dockPlay, icon(playing ? 'pause' : 'play'));
    mount(bigPlay, icon(playing ? 'pause' : 'play'));
    speedBtn.textContent = `${player.speed}×`;
    sleepBtn.classList.toggle('chip--on', !!player.sleep);
    mount(sleepBtn, icon('clock', 14), player.sleep
      ? (player.sleep.mode === 'chapter' ? 'End of chapter' : `${clockTime(Math.max(0, (player.sleep.until - Date.now()) / 1000))}`)
      : 'Sleep');
    player.updateSessionState();
  }

  player.addEventListener('change', () => { renderMeta(); renderTick(); renderState(); });
  player.addEventListener('tick', renderTick);
  player.addEventListener('state', renderState);
  player.addEventListener('error', (event) => toast(event.detail.message, 'bad'));
  player.addEventListener('sleep-finished', () => toast('Sleep timer — paused. Sweet dreams.'));
  player.addEventListener('finished', () => toast('Finished. Nice one.'));
  setInterval(() => { if (player.sleep) renderState(); }, 1000);

  document.addEventListener('keydown', (event) => {
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName)) return;
    const keys = {
      ' ': () => player.toggle(),
      k: () => player.toggle(),
      ArrowLeft: () => player.skip(-15),
      ArrowRight: () => player.skip(30),
      j: () => player.skip(-15),
      l: () => player.skip(30),
      Escape: () => closePlayer(),
    };
    const action = keys[event.key];
    if (action && player.book) {
      event.preventDefault();
      action();
    }
  });

  return { dock, sheet: player_, open: openPlayer, close: closePlayer };
}
